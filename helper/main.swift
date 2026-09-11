import Foundation

// MAR-93 loopback transport helper (clean-room, SubTandem-pattern).
//
// Launched by the plugin with:
//   helper --credentials <path> [--port 0] [--parent-pid N]
//          [--idle-timeout 300] [--upstream-timeout 120] [--liveness-interval 5]
//
// Handshake: prints `READY {"port":P,"pid":PID}` on stdout once listening.
// Fatal problems print `ERROR {"message":"..."}` on stdout and exit non-zero.
// The upstream base URL and API key live in the credentials file (mode 0600);
// the key never appears in argv, env, or logs.

struct Credentials: Codable {
    let baseUrl: String
    let apiKey: String
}

func fail(_ message: String, code: Int32 = 2) -> Never {
    let payload = try? JSONSerialization.data(withJSONObject: ["message": message])
    FileHandle.standardOutput.write(Data("ERROR ".utf8))
    FileHandle.standardOutput.write(payload ?? Data("{\"message\":\"fatal\"}".utf8))
    FileHandle.standardOutput.write(Data("\n".utf8))
    fflush(stdout)
    exit(code)
}

func emit(_ line: String) {
    FileHandle.standardOutput.write((line + "\n").data(using: .utf8)!)
    fflush(stdout)
}

// A client hanging up mid-response raises SIGPIPE; ignore it so the
// helper survives (send() then reports EPIPE instead).
signal(SIGPIPE, SIG_IGN)

// MARK: - Argument parsing

func argValue(_ name: String) -> String? {
    guard let index = CommandLine.arguments.firstIndex(of: name), index + 1 < CommandLine.arguments.count else { return nil }
    return CommandLine.arguments[index + 1]
}

func integerArg(_ name: String, _ fallback: Int32) -> Int32 {
    guard let raw = argValue(name), let value = Int32(raw) else { return fallback }
    return value
}

let credentialsPath = argValue("--credentials") ?? "credentials.json"
if let rawPort = argValue("--port"), let parsedPort = Int(rawPort), (parsedPort < 0 || parsedPort > 65535) {
    fail("port out of range: \(rawPort)")
}
let preferredPort = integerArg("--port", 0)
let parentPid = integerArg("--parent-pid", getppid())
let idleTimeout = Double(argValue("--idle-timeout") ?? "300") ?? 300
let upstreamTimeout = Double(argValue("--upstream-timeout") ?? "120") ?? 120
let livenessInterval = Double(argValue("--liveness-interval") ?? "5") ?? 5

// MARK: - Credentials

let fileManager = FileManager.default
guard fileManager.fileExists(atPath: credentialsPath) else {
    fail("credentials file not found at \(credentialsPath)")
}
let attributes = try? fileManager.attributesOfItem(atPath: credentialsPath)
let permissions = (attributes?[.posixPermissions] as? NSNumber)?.int16Value ?? 0
guard permissions == 0o600 else {
    fail("credentials file must have 0600 permissions (found \(String(permissions, radix: 8)))")
}

func loadCredentials() -> Credentials? {
    let attributes = try? fileManager.attributesOfItem(atPath: credentialsPath)
    let permissions = (attributes?[.posixPermissions] as? NSNumber)?.int16Value ?? 0
    guard permissions == 0o600 else { return nil }
    guard let data = fileManager.contents(atPath: credentialsPath) else { return nil }
    return try? JSONDecoder().decode(Credentials.self, from: data)
}

// MARK: - Upstream (URLSession, synchronous per request)

let sessionConfiguration = URLSessionConfiguration.ephemeral
sessionConfiguration.timeoutIntervalForRequest = upstreamTimeout
sessionConfiguration.timeoutIntervalForResource = upstreamTimeout + 5
let session = URLSession(configuration: sessionConfiguration)

struct ProxyResult {
    let status: Int
    let retryAfter: String?
    let contentType: String
    let body: Data
}

func proxyToUpstream(body: Data) -> ProxyResult {
    guard let credentials = loadCredentials() else {
        return ProxyResult(status: 500, retryAfter: nil, contentType: "application/json",
                           body: Data("{\"error\":{\"message\":\"credentials unreadable\"}}".utf8))
    }
    guard let url = URL(string: credentials.baseUrl.hasSuffix("/")
            ? credentials.baseUrl + "chat/completions"
            : credentials.baseUrl + "/chat/completions") else {
        return ProxyResult(status: 500, retryAfter: nil, contentType: "application/json",
                           body: Data("{\"error\":{\"message\":\"invalid base URL in credentials\"}}".utf8))
    }
    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    request.httpBody = body
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue("Bearer " + credentials.apiKey, forHTTPHeaderField: "Authorization")

    let semaphore = DispatchSemaphore(value: 0)
    var result: ProxyResult!
    let task = session.dataTask(with: request) { data, response, error in
        defer { semaphore.signal() }
        if let error = error {
            let timedOut = (error as NSError).code == NSURLErrorTimedOut
            let message = timedOut ? "upstream timeout" : "upstream request failed"
            result = ProxyResult(status: timedOut ? 504 : 502, retryAfter: nil, contentType: "application/json",
                                 body: Data("{\"error\":{\"message\":\"\(message)\"}}".utf8))
            return
        }
        guard let http = response as? HTTPURLResponse else {
            result = ProxyResult(status: 502, retryAfter: nil, contentType: "application/json",
                                 body: Data("{\"error\":{\"message\":\"non-HTTP upstream response\"}}".utf8))
            return
        }
        result = ProxyResult(
            status: http.statusCode,
            retryAfter: http.value(forHTTPHeaderField: "Retry-After"),
            contentType: http.value(forHTTPHeaderField: "Content-Type") ?? "application/json",
            body: data ?? Data())
    }
    task.resume()
    semaphore.wait()
    return result
}

// MARK: - Minimal HTTP server over POSIX sockets (loopback only)

func writeAll(_ fd: Int32, _ data: Data) {
    data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
        var offset = 0
        while offset < data.count {
            let sent = send(fd, raw.baseAddress!.advanced(by: offset), data.count - offset, 0)
            if sent <= 0 { return }
            offset += sent
        }
    }
}

func respond(_ fd: Int32, status: Int, reason: String, contentType: String, extraHeaders: String = "", body: Data) {
    let head = "HTTP/1.1 \(status) \(reason)\r\nContent-Type: \(contentType)\r\nContent-Length: \(body.count)\r\nConnection: close\(extraHeaders.isEmpty ? "" : "\r\n" + extraHeaders)\r\n\r\n"
    writeAll(fd, Data(head.utf8))
    writeAll(fd, body)
}

func handleConnection(_ fd: Int32) {
    defer { close(fd) }
    var buffer = Data()
    var chunk = [UInt8](repeating: 0, count: 16384)
    // Read until the header terminator, then any Content-Length body bytes.
    var headerEnd = -1
    var contentLength = 0
    while headerEnd == -1 {
        let n = recv(fd, &chunk, chunk.count, 0)
        if n <= 0 { return }
        buffer.append(contentsOf: chunk[0..<n])
        if let range = buffer.range(of: Data("\r\n\r\n".utf8)) {
            headerEnd = range.upperBound
            let headers = String(data: buffer.subdata(in: buffer.startIndex..<range.lowerBound), encoding: .utf8) ?? ""
            for line in headers.split(separator: "\r\n") {
                let parts = line.split(separator: ":", maxSplits: 1)
                if parts.count == 2 && parts[0].lowercased() == "content-length" {
                    contentLength = Int(parts[1].trimmingCharacters(in: .whitespaces)) ?? 0
                    if contentLength > 10_000_000 {
                        return respond(fd, status: 413, reason: "Payload Too Large", contentType: "application/json",
                                       body: Data("{\"error\":{\"message\":\"request body too large\"}}".utf8))
                    }
                }
            }
        }
    }
    while buffer.count < headerEnd + contentLength {
        let n = recv(fd, &chunk, chunk.count, 0)
        if n <= 0 { break }
        buffer.append(contentsOf: chunk[0..<n])
    }
    let requestText = String(data: buffer.prefix(headerEnd), encoding: .utf8) ?? ""
    let requestLines = requestText.split(separator: "\r\n")
    let requestLine = requestLines.first.map(String.init) ?? ""
    let parts = requestLine.split(separator: " ")
    guard parts.count >= 2 else {
        return respond(fd, status: 400, reason: "Bad Request", contentType: "application/json",
                       body: Data("{\"error\":{\"message\":\"malformed request\"}}".utf8))
    }
    let method = String(parts[0])
    let path = String(parts[1])

    touchActivity()

    if path == "/health" {
        return respond(fd, status: 200, reason: "OK", contentType: "application/json", body: Data("{\"ok\":true}".utf8))
    }
    guard method == "POST", path == "/chat/completions" else {
        return respond(fd, status: 404, reason: "Not Found", contentType: "application/json",
                       body: Data("{\"error\":{\"message\":\"not found\"}}".utf8))
    }
    let result = proxyToUpstream(body: buffer.subdata(in: headerEnd..<buffer.count))
    let retryHeader = result.retryAfter.map { "Retry-After: \($0)" } ?? ""
    respond(fd, status: result.status,
            reason: result.status == 200 ? "OK" : (result.status == 429 ? "Too Many Requests" : "Error"),
            contentType: result.contentType, extraHeaders: retryHeader, body: result.body)
}

let activityLock = NSLock()
var lastActivityStorage = Date()
func touchActivity() {
    activityLock.lock()
    lastActivityStorage = Date()
    activityLock.unlock()
}
func activityAge() -> TimeInterval {
    activityLock.lock()
    defer { activityLock.unlock() }
    return Date().timeIntervalSince(lastActivityStorage)
}

// MARK: - Socket bootstrap

let serverFD = socket(AF_INET, SOCK_STREAM, 0)
guard serverFD >= 0 else { fail("socket() failed") }
var yes: Int32 = 1
setsockopt(serverFD, SOL_SOCKET, SO_REUSEADDR, &yes, socklen_t(MemoryLayout<Int32>.size))

var address = sockaddr_in()
address.sin_family = sa_family_t(AF_INET)
address.sin_port = UInt16(preferredPort).bigEndian
address.sin_addr = in_addr(s_addr: INADDR_LOOPBACK.bigEndian)

let bindResult = withUnsafePointer(to: &address) {
    $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
        bind(serverFD, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
    }
}
guard bindResult == 0 else {
    let error = String(cString: strerror(errno))
    fail("cannot bind port \(preferredPort): \(error)", code: 3)
}
guard listen(serverFD, 16) == 0 else { fail("listen() failed", code: 3) }

var boundAddress = sockaddr_in()
var boundLength = socklen_t(MemoryLayout<sockaddr_in>.size)
getsockname(serverFD, withUnsafeMutablePointer(to: &boundAddress) {
    $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { $0 }
}, &boundLength)
let boundPort = UInt16(bigEndian: boundAddress.sin_port)

let readyPayload = "{\"port\":\(boundPort),\"pid\":\(getpid())}"
emit("READY \(readyPayload)")

// MARK: - Liveness and idle supervision

let supervisionQueue = DispatchQueue(label: "supervision")
let supervisionTimer = DispatchSource.makeTimerSource(queue: supervisionQueue)
supervisionTimer.schedule(deadline: .now() + livenessInterval, repeating: livenessInterval)
supervisionTimer.setEventHandler {
    if getppid() != parentPid { exit(0) }          // parent died -> orphaned
    if activityAge() > idleTimeout { exit(0) }
}
supervisionTimer.resume()

// MARK: - Accept loop

let acceptThread = Thread {
    while true {
        let clientFD = accept(serverFD, nil, nil)
        if clientFD < 0 { usleep(10_000); continue }
        let thread = Thread {
            handleConnection(clientFD)
        }
        thread.stackSize = 1 << 20
        thread.start()
    }
}
acceptThread.stackSize = 1 << 20
acceptThread.start()

dispatchMain()
