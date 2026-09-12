import Foundation

// The plugin keeps one helper per IINA process. Each client request is short:
// POST /requests submits a job, GET /requests/<id> polls its result, and DELETE
// releases a completed result. The helper owns upstream requests and credentials.
// READY includes the random token required on every endpoint except /health.

struct Credentials: Codable {
    let baseUrl: String
    let apiKey: String
}

func jsonData(_ value: Any) -> Data {
    return (try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .fragmentsAllowed])) ?? Data("null".utf8)
}

func fail(_ message: String, code: Int32 = 2) -> Never {
    FileHandle.standardOutput.write(Data("ERROR ".utf8) + jsonData(["message": message]) + Data("\n".utf8))
    fflush(stdout)
    exit(code)
}

signal(SIGPIPE, SIG_IGN)

func argValue(_ name: String) -> String? {
    guard let index = CommandLine.arguments.firstIndex(of: name), index + 1 < CommandLine.arguments.count else { return nil }
    return CommandLine.arguments[index + 1]
}

func positiveArg(_ name: String, _ fallback: Double) -> Double {
    guard let raw = argValue(name) else { return fallback }
    guard let value = Double(raw), value.isFinite, value > 0 else { fail("invalid \(name)") }
    return value
}

let credentialsPath = argValue("--credentials") ?? "credentials.json"
let rawPort = argValue("--port") ?? "0"
guard let preferredPort = UInt16(rawPort) else { fail("invalid port: \(rawPort)") }
let parentPid = argValue("--parent-pid").flatMap(Int32.init) ?? getppid()
let idleTimeout = positiveArg("--idle-timeout", 300)
let upstreamTimeout = positiveArg("--upstream-timeout", 120)
let livenessInterval = positiveArg("--liveness-interval", 5)
let completedRetention = positiveArg("--completed-retention", 600)
let rawMaxJobs = argValue("--max-jobs") ?? "32"
guard let maxJobs = Int(rawMaxJobs), maxJobs > 0, maxJobs <= 1024 else { fail("invalid --max-jobs") }
let sessionToken = UUID().uuidString.replacingOccurrences(of: "-", with: "") + UUID().uuidString.replacingOccurrences(of: "-", with: "")
let fileManager = FileManager.default

// MARK: - Credentials

let credentialsLock = NSLock()

@Sendable func credentialsPermissions() -> Int? {
    return ((try? fileManager.attributesOfItem(atPath: credentialsPath)[.posixPermissions]) as? NSNumber)?.intValue
}

if fileManager.fileExists(atPath: credentialsPath), credentialsPermissions() != 0o600 {
    fail("credentials file must have 0600 permissions")
}

// Must be called with credentialsLock held. A missing file is a fresh install.
@Sendable func readCredentials() throws -> Credentials {
    if !fileManager.fileExists(atPath: credentialsPath) { return Credentials(baseUrl: "", apiKey: "") }
    guard credentialsPermissions() == 0o600 else { throw HelperError("credentials file must have 0600 permissions") }
    return try JSONDecoder().decode(Credentials.self, from: Data(contentsOf: URL(fileURLWithPath: credentialsPath)))
}

struct HelperError: Error {
    let message: String
    init(_ message: String) { self.message = message }
}

@Sendable func validBaseUrl(_ value: String) -> Bool {
    guard let url = URL(string: value), let scheme = url.scheme?.lowercased() else { return false }
    return (scheme == "http" || scheme == "https") && url.host != nil && url.user == nil && url.password == nil
}

@Sendable func isConfigured(_ credentials: Credentials) -> Bool {
    return validBaseUrl(credentials.baseUrl) && !credentials.apiKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
}

// A same-directory exclusive temporary file is 0600 from creation, including
// while its contents are written. Rename publishes the complete file atomically.
@Sendable func writeCredentials(_ credentials: Credentials) throws {
    let destination = URL(fileURLWithPath: credentialsPath)
    let directory = destination.deletingLastPathComponent()
    try fileManager.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    let temporaryPath = directory.appendingPathComponent(".credentials-\(UUID().uuidString).tmp").path
    let fd = open(temporaryPath, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, mode_t(0o600))
    guard fd >= 0 else { throw HelperError("cannot create credentials file") }
    defer {
        close(fd)
        unlink(temporaryPath)
    }
    guard fchmod(fd, mode_t(0o600)) == 0 else { throw HelperError("cannot protect credentials file") }
    let data = try JSONEncoder().encode(credentials)
    let written = data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) -> Bool in
        var offset = 0
        while offset < data.count {
            let count = write(fd, raw.baseAddress!.advanced(by: offset), data.count - offset)
            if count < 0 && errno == EINTR { continue }
            if count <= 0 { return false }
            offset += count
        }
        return true
    }
    guard written, fsync(fd) == 0 else { throw HelperError("cannot write credentials file") }
    guard rename(temporaryPath, credentialsPath) == 0 else { throw HelperError("cannot replace credentials file") }
}

// MARK: - Upstream

let sessionConfiguration = URLSessionConfiguration.ephemeral
sessionConfiguration.timeoutIntervalForRequest = upstreamTimeout
sessionConfiguration.timeoutIntervalForResource = upstreamTimeout + 5
let session = URLSession(configuration: sessionConfiguration)

struct ProxyResult {
    let status: Int
    let retryAfter: String?
    let contentType: String
    let body: Data

    var envelope: [String: Any] {
        return [
            "status": status,
            "text": String(data: body, encoding: .utf8) ?? "",
            "json": (try? JSONSerialization.jsonObject(with: body, options: .fragmentsAllowed)) ?? NSNull(),
            "retryAfter": retryAfter as Any? ?? NSNull()
        ]
    }
}

func proxyToUpstream(body: Data, credentials: Credentials) -> ProxyResult {
    guard validBaseUrl(credentials.baseUrl), let url = URL(string: credentials.baseUrl.hasSuffix("/")
        ? credentials.baseUrl + "chat/completions" : credentials.baseUrl + "/chat/completions") else {
        return ProxyResult(status: 500, retryAfter: nil, contentType: "application/json",
                           body: jsonData(["error": ["message": "invalid base URL in credentials"]]))
    }
    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    request.httpBody = body
    request.timeoutInterval = upstreamTimeout
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue("Bearer " + credentials.apiKey, forHTTPHeaderField: "Authorization")

    let semaphore = DispatchSemaphore(value: 0)
    var result: ProxyResult!
    let task = session.dataTask(with: request) { data, response, error in
        defer { semaphore.signal() }
        if let error = error {
            let timedOut = (error as NSError).code == NSURLErrorTimedOut
            result = ProxyResult(status: timedOut ? 504 : 502, retryAfter: nil, contentType: "application/json",
                                 body: jsonData(["error": ["message": timedOut ? "upstream timeout" : "upstream request failed"]]))
        } else if let http = response as? HTTPURLResponse {
            result = ProxyResult(status: http.statusCode, retryAfter: http.value(forHTTPHeaderField: "Retry-After"),
                                 contentType: http.value(forHTTPHeaderField: "Content-Type") ?? "application/json", body: data ?? Data())
        } else {
            result = ProxyResult(status: 502, retryAfter: nil, contentType: "application/json",
                                 body: jsonData(["error": ["message": "non-HTTP upstream response"]]))
        }
    }
    task.resume()
    semaphore.wait()
    return result
}

// MARK: - Jobs and idle supervision

struct Job {
    let body: Data
    var response: ProxyResult?
    var completedAt: Date?
}
let jobsLock = NSLock()
var jobs: [String: Job] = [:]
var directRequests = 0
let activityLock = NSLock()
var lastActivity = Date()

@Sendable func touchActivity() {
    activityLock.lock()
    lastActivity = Date()
    activityLock.unlock()
}

func activityAge() -> TimeInterval {
    activityLock.lock()
    defer { activityLock.unlock() }
    return Date().timeIntervalSince(lastActivity)
}

// Must be called with jobsLock held. Pending jobs are never expired or evicted.
@Sendable func purgeCompletedJobs() {
    let now = Date()
    jobs = jobs.filter { _, job in
        guard let completedAt = job.completedAt else { return true }
        return now.timeIntervalSince(completedAt) < completedRetention
    }
}

@Sendable func jobEnvelope(_ id: String, _ job: Job) -> [String: Any] {
    if let response = job.response { return ["id": id, "state": "completed", "response": response.envelope] }
    return ["id": id, "state": "pending"]
}

@Sendable func validJobId(_ value: String) -> Bool {
    return !value.isEmpty && value.utf8.count <= 128 && value.unicodeScalars.allSatisfy {
        (48...57).contains($0.value) || (65...90).contains($0.value) || (97...122).contains($0.value) || $0 == "-" || $0 == "_"
    }
}

// MARK: - HTTP

@Sendable func writeAll(_ fd: Int32, _ data: Data) {
    data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
        var offset = 0
        while offset < data.count {
            let sent = send(fd, raw.baseAddress!.advanced(by: offset), data.count - offset, 0)
            if sent < 0 && errno == EINTR { continue }
            if sent <= 0 { return }
            offset += sent
        }
    }
}

@Sendable func respond(_ fd: Int32, status: Int = 200, contentType: String = "application/json", extraHeaders: String = "", body: Data) {
    let head = "HTTP/1.1 \(status) \(status < 400 ? "OK" : "Error")\r\nContent-Type: \(contentType)\r\nContent-Length: \(body.count)\r\nConnection: close\r\nCache-Control: no-store\(extraHeaders.isEmpty ? "" : "\r\n" + extraHeaders)\r\n\r\n"
    writeAll(fd, Data(head.utf8))
    writeAll(fd, body)
}

@Sendable func respondJSON(_ fd: Int32, status: Int = 200, _ value: Any) {
    respond(fd, status: status, body: jsonData(value))
}

@Sendable func respondError(_ fd: Int32, _ status: Int, _ message: String) {
    respondJSON(fd, status: status, ["error": ["message": message]])
}

func handleConnection(_ fd: Int32) {
    defer { close(fd) }
    var socketTimeout = timeval(tv_sec: 10, tv_usec: 0)
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &socketTimeout, socklen_t(MemoryLayout<timeval>.size))
    setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &socketTimeout, socklen_t(MemoryLayout<timeval>.size))
    var buffer = Data()
    var chunk = [UInt8](repeating: 0, count: 16384)
    var headerEnd: Int?
    var headerText = ""
    while headerEnd == nil {
        let count = recv(fd, &chunk, chunk.count, 0)
        if count <= 0 { return }
        buffer.append(contentsOf: chunk[0..<count])
        if let range = buffer.range(of: Data("\r\n\r\n".utf8)) {
            if range.lowerBound > 32768 { return respondError(fd, 431, "request headers too large") }
            headerEnd = range.upperBound
            headerText = String(data: buffer.prefix(range.lowerBound), encoding: .utf8) ?? ""
        } else if buffer.count > 32768 { return respondError(fd, 431, "request headers too large") }
    }
    let lines = headerText.components(separatedBy: "\r\n")
    let parts = (lines.first ?? "").split(separator: " ")
    guard parts.count == 3 else { return respondError(fd, 400, "malformed request") }
    let method = String(parts[0])
    let path = String(parts[1])
    var headers: [String: String] = [:]
    for line in lines.dropFirst() {
        let fields = line.split(separator: ":", maxSplits: 1)
        guard fields.count == 2 else { return respondError(fd, 400, "malformed header") }
        let name = fields[0].lowercased()
        guard headers[name] == nil else { return respondError(fd, 400, "duplicate header") }
        headers[name] = fields[1].trimmingCharacters(in: .whitespaces)
    }
    // The native client sends a complete JSON body with Content-Length.
    // Reject unsupported framing instead of accidentally forwarding chunk bytes.
    guard headers["transfer-encoding"] == nil else { return respondError(fd, 400, "Content-Length is required") }
    guard let contentLength = Int(headers["content-length"] ?? "0"), contentLength >= 0 else {
        return respondError(fd, 400, "invalid Content-Length")
    }
    guard contentLength <= 10_000_000 else { return respondError(fd, 413, "request body too large") }
    if path == "/health" && method == "GET" { return respondJSON(fd, ["ok": true]) }
    guard headers["authorization"] == "Bearer " + sessionToken else { return respondError(fd, 401, "unauthorized") }
    let bodyStart = headerEnd!
    while buffer.count < bodyStart + contentLength {
        let count = recv(fd, &chunk, chunk.count, 0)
        if count <= 0 { return respondError(fd, 400, "incomplete request body") }
        buffer.append(contentsOf: chunk[0..<count])
    }
    let body = buffer.subdata(in: bodyStart..<(bodyStart + contentLength))
    touchActivity()

    if path == "/credentials" {
        credentialsLock.lock()
        defer { credentialsLock.unlock() }
        do {
            let existing = try readCredentials()
            if method == "GET" {
                return respondJSON(fd, ["configured": isConfigured(existing), "baseUrl": existing.baseUrl])
            }
            guard method == "POST" else { return respondError(fd, 405, "method not allowed") }
            guard let update = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any],
                  update["apiKey"] != nil || update["baseUrl"] != nil else {
                return respondError(fd, 400, "expected apiKey or baseUrl")
            }
            if let key = update["apiKey"], !(key is String) { return respondError(fd, 400, "apiKey must be a string") }
            if let url = update["baseUrl"], !(url is String) { return respondError(fd, 400, "baseUrl must be a string") }
            let updated = Credentials(baseUrl: update["baseUrl"] as? String ?? existing.baseUrl,
                                      apiKey: update["apiKey"] as? String ?? existing.apiKey)
            guard updated.baseUrl.isEmpty || validBaseUrl(updated.baseUrl) else { return respondError(fd, 400, "baseUrl must be an HTTP or HTTPS URL") }
            try writeCredentials(updated)
            return respondJSON(fd, ["configured": isConfigured(updated), "baseUrl": updated.baseUrl])
        } catch {
            return respondError(fd, 500, "credentials unavailable")
        }
    }

    if path == "/requests" && method == "POST" {
        guard let submission = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any],
              let id = submission["id"] as? String, validJobId(id), let requestBody = submission["body"] as? [String: Any] else {
            return respondError(fd, 400, "expected a request id and JSON body")
        }
        let encodedBody = jsonData(requestBody)
        jobsLock.lock()
        purgeCompletedJobs()
        if let existing = jobs[id] {
            jobsLock.unlock()
            guard existing.body == encodedBody else { return respondError(fd, 409, "request id already has a different body") }
            return respondJSON(fd, status: 202, jobEnvelope(id, existing))
        }
        guard jobs.count < maxJobs else {
            jobsLock.unlock()
            return respondError(fd, 429, "too many retained requests")
        }
        credentialsLock.lock()
        let credentials = try? readCredentials()
        credentialsLock.unlock()
        guard let credentials = credentials, isConfigured(credentials) else {
            jobsLock.unlock()
            return respondError(fd, 409, "credentials are not configured")
        }
        jobs[id] = Job(body: encodedBody)
        jobsLock.unlock()
        let thread = Thread {
            let response = proxyToUpstream(body: encodedBody, credentials: credentials)
            jobsLock.lock()
            jobs[id]?.response = response
            jobs[id]?.completedAt = Date()
            touchActivity()
            jobsLock.unlock()
        }
        thread.stackSize = 1 << 20
        thread.start()
        return respondJSON(fd, status: 202, ["id": id, "state": "pending"])
    }

    if path.hasPrefix("/requests/") {
        let id = String(path.dropFirst("/requests/".count))
        guard validJobId(id) else { return respondError(fd, 400, "invalid request id") }
        jobsLock.lock()
        defer { jobsLock.unlock() }
        purgeCompletedJobs()
        guard let job = jobs[id] else { return respondError(fd, 404, "request not found") }
        if method == "GET" { return respondJSON(fd, jobEnvelope(id, job)) }
        if method == "DELETE" {
            guard job.response != nil else { return respondError(fd, 409, "request is still pending") }
            jobs.removeValue(forKey: id)
            return respondJSON(fd, ["id": id, "deleted": true])
        }
        return respondError(fd, 405, "method not allowed")
    }

    // Compatibility for existing clients; new clients always use short jobs.
    if path == "/chat/completions" && method == "POST" {
        credentialsLock.lock()
        let credentials = try? readCredentials()
        credentialsLock.unlock()
        guard let credentials = credentials, isConfigured(credentials) else { return respondError(fd, 409, "credentials are not configured") }
        jobsLock.lock()
        directRequests += 1
        jobsLock.unlock()
        let result = proxyToUpstream(body: body, credentials: credentials)
        jobsLock.lock()
        directRequests -= 1
        touchActivity()
        jobsLock.unlock()
        return respond(fd, status: result.status, contentType: result.contentType,
                       extraHeaders: result.retryAfter.map { "Retry-After: \($0)" } ?? "", body: result.body)
    }
    respondError(fd, 404, "not found")
}

// MARK: - Socket bootstrap

let serverFD = socket(AF_INET, SOCK_STREAM, 0)
guard serverFD >= 0 else { fail("socket() failed") }
var yes: Int32 = 1
setsockopt(serverFD, SOL_SOCKET, SO_REUSEADDR, &yes, socklen_t(MemoryLayout<Int32>.size))
var address = sockaddr_in()
address.sin_family = sa_family_t(AF_INET)
address.sin_port = preferredPort.bigEndian
address.sin_addr = in_addr(s_addr: INADDR_LOOPBACK.bigEndian)
let bindResult = withUnsafePointer(to: &address) {
    $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(serverFD, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
}
guard bindResult == 0 else { fail("cannot bind port \(preferredPort): \(String(cString: strerror(errno)))", code: 3) }
guard listen(serverFD, 16) == 0 else { fail("listen() failed", code: 3) }
var boundAddress = sockaddr_in()
var boundLength = socklen_t(MemoryLayout<sockaddr_in>.size)
withUnsafeMutablePointer(to: &boundAddress) {
    $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { _ = getsockname(serverFD, $0, &boundLength) }
}
let boundPort = UInt16(bigEndian: boundAddress.sin_port)
FileHandle.standardOutput.write(Data("READY ".utf8) + jsonData(["port": Int(boundPort), "pid": Int(getpid()), "token": sessionToken]) + Data("\n".utf8))
fflush(stdout)

let supervisionQueue = DispatchQueue(label: "supervision")
let supervisionTimer = DispatchSource.makeTimerSource(queue: supervisionQueue)
supervisionTimer.schedule(deadline: .now() + livenessInterval, repeating: livenessInterval)
supervisionTimer.setEventHandler {
    if getppid() != parentPid { exit(0) }
    jobsLock.lock()
    purgeCompletedJobs()
    let active = directRequests > 0 || jobs.values.contains { $0.response == nil }
    let idle = !active && activityAge() > idleTimeout
    jobsLock.unlock()
    if idle { exit(0) }
}
supervisionTimer.resume()
let acceptThread = Thread {
    while true {
        let clientFD = accept(serverFD, nil, nil)
        if clientFD < 0 { usleep(10_000); continue }
        let thread = Thread { handleConnection(clientFD) }
        thread.stackSize = 1 << 20
        thread.start()
    }
}
acceptThread.stackSize = 1 << 20
acceptThread.start()
dispatchMain()
