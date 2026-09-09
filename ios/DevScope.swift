// DevScope.swift — drop-in for iOS apps (debug builds only). Requires iOS 13+.
//
// Setup, once at launch and only in debug builds:
//
//     #if DEBUG
//     DevScope.start()
//     #endif
//
// Network: a URLProtocol mirrors every URLSession request/response — HTTPS included, because it
// runs inside the app — to the DevScope server. It is injected into URLSession.shared and into
// URLSessionConfiguration.default / .ephemeral, so sessions created after start() (Alamofire,
// Moya, plain URLSession) are covered.
//
// Layout: a WebSocket agent answers layout captures with the UIKit view hierarchy, the SwiftUI
// accessibility tree (SwiftUI does not expose its internal tree) and a screenshot.
//
// Transport: simulators reach the Mac through localhost. Physical devices discover the server
// over Bonjour (_devscope._tcp) on the same Wi-Fi — Info.plist needs NSLocalNetworkUsageDescription
// and NSBonjourServices = ["_devscope._tcp"] — or set DevScope.serverHost to the Mac's IP.
// Plain http/ws to the dev machine also needs NSAppTransportSecurity > NSAllowsLocalNetworking.
//
// The whole file compiles to nothing outside DEBUG.

#if DEBUG
import Foundation
import UIKit
import Network
import ObjectiveC

public enum DevScope {
    /// Set this before start() to skip Bonjour discovery (e.g. the Mac's LAN IP for a physical device).
    public static var serverHost: String?
    public static private(set) var port = 8765
    /// Bodies larger than this are truncated in the inspector (the app still receives them whole).
    public static var maxBodyBytes = 512 * 1024

    private static var started = false

    public static func start(port: Int = 8765) {
        guard !started else { return }
        started = true
        self.port = port
        DevScopeTransport.shared.start()
        DevScopeURLProtocol.install()
        DevScopeLayoutAgent.shared.start()
    }
}

// MARK: - Identity

enum DevScopeIdentity {
    static let appId = Bundle.main.bundleIdentifier ?? "unknown"
    static let vendorId = UIDevice.current.identifierForVendor?.uuidString ?? ""
    static let simulatorUdid = ProcessInfo.processInfo.environment["SIMULATOR_UDID"]

    /// Fields every report carries so the server can attribute it to a device.
    static var common: [String: Any] {
        var o: [String: Any] = [
            "platform": "ios",
            "appId": appId,
            "vendorId": vendorId,
            "deviceModel": "\(UIDevice.current.model) (\(UIDevice.current.systemName) \(UIDevice.current.systemVersion))",
        ]
        if let udid = simulatorUdid { o["simulatorUdid"] = udid }
        return o
    }
}

// MARK: - Transport (where is the DevScope server?)

final class DevScopeTransport {
    static let shared = DevScopeTransport()

    private(set) var baseURL: URL?
    var onReady: (() -> Void)?
    private var browser: NWBrowser?
    private var probe: NWConnection?

    var isSimulator: Bool {
        #if targetEnvironment(simulator)
        return true
        #else
        return false
        #endif
    }

    func start() {
        if let host = DevScope.serverHost { setBase(host: host, port: DevScope.port); return }
        if isSimulator { setBase(host: "localhost", port: DevScope.port); return }
        browse()
    }

    /// True for requests that go to DevScope itself, which must never be mirrored.
    func isOwn(_ url: URL) -> Bool {
        guard let host = url.host?.lowercased() else { return false }
        if let base = baseURL, let baseHost = base.host?.lowercased() {
            return host == baseHost && url.port == base.port
        }
        return (host == "localhost" || host == "127.0.0.1") && url.port == DevScope.port
    }

    private func setBase(host: String, port: Int) {
        let literal = host.contains(":") && !host.hasPrefix("[") ? "[\(host)]" : host
        baseURL = URL(string: "http://\(literal):\(port)")
        NSLog("DevScope: server at %@", baseURL?.absoluteString ?? "?")
        onReady?()
    }

    private func browse() {
        let params = NWParameters.tcp
        params.includePeerToPeer = true
        let browser = NWBrowser(for: .bonjour(type: "_devscope._tcp", domain: nil), using: params)
        browser.browseResultsChangedHandler = { [weak self] results, _ in
            guard let self = self, self.baseURL == nil, let first = results.first else { return }
            self.resolve(first.endpoint)
        }
        browser.stateUpdateHandler = { state in
            if case .failed(let error) = state { NSLog("DevScope: Bonjour browse failed: %@", "\(error)") }
        }
        browser.start(queue: .global(qos: .utility))
        self.browser = browser
    }

    /// Bonjour gives us a service endpoint; open a throw-away connection to learn its host:port.
    private func resolve(_ endpoint: NWEndpoint) {
        let connection = NWConnection(to: endpoint, using: .tcp)
        connection.stateUpdateHandler = { [weak self] state in
            guard let self = self else { return }
            switch state {
            case .ready:
                if case .hostPort(let host, let port)? = connection.currentPath?.remoteEndpoint {
                    var literal = "\(host)"
                    if let scope = literal.firstIndex(of: "%") { literal = String(literal[..<scope]) }
                    self.setBase(host: literal, port: Int(port.rawValue))
                    self.browser?.cancel()
                }
                connection.cancel()
            case .failed, .cancelled:
                connection.cancel()
            default:
                break
            }
        }
        connection.start(queue: .global(qos: .utility))
        probe = connection
    }
}

// MARK: - Reporter (HTTP POST /ingest through a session that is NOT intercepted)

enum DevScopeReporter {
    static let session: URLSession = {
        let cfg = URLSessionConfiguration.ephemeral
        cfg.protocolClasses = (cfg.protocolClasses ?? []).filter { $0 != DevScopeURLProtocol.self }
        cfg.timeoutIntervalForRequest = 3
        return URLSession(configuration: cfg)
    }()

    static func post(_ event: [String: Any]) {
        guard let base = DevScopeTransport.shared.baseURL,
              let body = try? JSONSerialization.data(withJSONObject: event) else { return }
        let request = NSMutableURLRequest(url: base.appendingPathComponent("ingest"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = body
        URLProtocol.setProperty(true, forKey: DevScopeURLProtocol.handledKey, in: request)
        session.dataTask(with: request as URLRequest).resume()
    }

    static func isTextLike(_ contentType: String) -> Bool {
        let t = contentType.lowercased()
        return t.isEmpty || t.contains("json") || t.contains("text") || t.contains("xml")
            || t.contains("x-www-form-urlencoded") || t.contains("javascript")
    }
}

// MARK: - Network interceptor

final class DevScopeURLProtocol: URLProtocol {
    static let handledKey = "dev.devscope.handled"

    private var session: URLSession?
    private var task: URLSessionDataTask?
    private var event: [String: Any] = [:]
    private var startedAt = Date()
    private var response: HTTPURLResponse?
    private var responseBody = Data()
    private var responseTruncated = false
    private var reported = false
    private var redirected = false

    static func install() {
        URLProtocol.registerClass(DevScopeURLProtocol.self)
        swizzle(#selector(getter: URLSessionConfiguration.default), with: #selector(URLSessionConfiguration.devscope_default))
        swizzle(#selector(getter: URLSessionConfiguration.ephemeral), with: #selector(URLSessionConfiguration.devscope_ephemeral))
    }

    private static func swizzle(_ original: Selector, with replacement: Selector) {
        guard let m1 = class_getClassMethod(URLSessionConfiguration.self, original),
              let m2 = class_getClassMethod(URLSessionConfiguration.self, replacement) else { return }
        method_exchangeImplementations(m1, m2)
    }

    // MARK: URLProtocol

    override class func canInit(with request: URLRequest) -> Bool {
        guard let url = request.url, let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" else { return false }
        if URLProtocol.property(forKey: handledKey, in: request) != nil { return false }
        if DevScopeTransport.shared.isOwn(url) { return false }
        return true
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        startedAt = Date()
        var inner = request
        let body = Self.readBody(&inner)   // also turns a body stream back into httpBody for the inner task

        event = DevScopeIdentity.common
        event["startedAt"] = Int(startedAt.timeIntervalSince1970 * 1000)
        event["method"] = request.httpMethod ?? "GET"
        event["url"] = request.url?.absoluteString ?? ""
        event["requestHeaders"] = request.allHTTPHeaderFields ?? [:]
        if let body = body {
            let type = request.value(forHTTPHeaderField: "Content-Type") ?? ""
            event["requestBody"] = DevScopeReporter.isTextLike(type)
                ? (String(data: body.prefix(DevScope.maxBodyBytes), encoding: .utf8) ?? "<non-utf8 body>")
                : "<binary \(type)>"
        }

        guard let marked = (inner as NSURLRequest).mutableCopy() as? NSMutableURLRequest else { return }
        URLProtocol.setProperty(true, forKey: Self.handledKey, in: marked)
        let cfg = URLSessionConfiguration.default
        cfg.protocolClasses = (cfg.protocolClasses ?? []).filter { $0 != DevScopeURLProtocol.self }
        let session = URLSession(configuration: cfg, delegate: self, delegateQueue: nil)
        self.session = session
        let task = session.dataTask(with: marked as URLRequest)
        self.task = task
        task.resume()
    }

    override func stopLoading() {
        task?.cancel()
        session?.finishTasksAndInvalidate()
    }

    // MARK: helpers

    private static func readBody(_ request: inout URLRequest) -> Data? {
        if let data = request.httpBody { return data }
        guard let stream = request.httpBodyStream else { return nil }
        stream.open()
        defer { stream.close() }
        var out = Data()
        var buffer = [UInt8](repeating: 0, count: 64 * 1024)
        while stream.hasBytesAvailable {
            let n = stream.read(&buffer, maxLength: buffer.count)
            if n <= 0 { break }
            out.append(buffer, count: n)
        }
        request.httpBodyStream = nil
        request.httpBody = out
        return out
    }

    private func finish(error: Error?) {
        guard !reported else { return }
        reported = true
        event["durationMs"] = Int(Date().timeIntervalSince(startedAt) * 1000)
        if let r = response {
            event["status"] = r.statusCode
            var headers: [String: String] = [:]
            for (k, v) in r.allHeaderFields { headers["\(k)"] = "\(v)" }
            event["responseHeaders"] = headers
            let type = headers.first { $0.key.lowercased() == "content-type" }?.value ?? ""
            if DevScopeReporter.isTextLike(type) {
                var text = String(data: responseBody, encoding: .utf8) ?? "<non-utf8 body>"
                if responseTruncated { text += "\n… [truncated by DevScope]" }
                event["responseBody"] = text
            } else {
                event["responseBody"] = "<binary \(type)>"
            }
            event["responseSize"] = r.expectedContentLength >= 0 ? Int(r.expectedContentLength) : responseBody.count
        }
        if let error = error { event["error"] = "\(error)" }
        DevScopeReporter.post(event)
    }
}

extension DevScopeURLProtocol: URLSessionDataDelegate {
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        self.response = response as? HTTPURLResponse
        if !redirected { client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed) }
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        let room = DevScope.maxBodyBytes - responseBody.count
        if room > 0 { responseBody.append(data.prefix(room)) }
        if data.count > room { responseTruncated = true }
        if !redirected { client?.urlProtocol(self, didLoad: data) }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        finish(error: error)
        if !redirected {
            if let error = error { client?.urlProtocol(self, didFailWithError: error) }
            else { client?.urlProtocolDidFinishLoading(self) }
        }
        session.finishTasksAndInvalidate()
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        // Report this leg, then hand the redirect back to the caller's session: it re-issues the
        // new request, which comes through canInit again as a fresh capture.
        self.response = response
        finish(error: nil)
        redirected = true
        var clean = request
        if let m = (request as NSURLRequest).mutableCopy() as? NSMutableURLRequest {
            URLProtocol.removeProperty(forKey: Self.handledKey, in: m)
            clean = m as URLRequest
        }
        client?.urlProtocol(self, wasRedirectedTo: clean, redirectResponse: response)
        completionHandler(nil)
        task.cancel()
        client?.urlProtocol(self, didFailWithError: NSError(domain: NSCocoaErrorDomain, code: NSUserCancelledError, userInfo: nil))
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        completionHandler(.performDefaultHandling, nil)
    }
}

extension URLSessionConfiguration {
    // Swizzled with the `default` / `ephemeral` getters: every new configuration carries the interceptor first.
    @objc class func devscope_default() -> URLSessionConfiguration {
        let cfg = devscope_default()   // calls the original getter (implementations are exchanged)
        cfg.protocolClasses = [DevScopeURLProtocol.self] + (cfg.protocolClasses ?? []).filter { $0 != DevScopeURLProtocol.self }
        return cfg
    }

    @objc class func devscope_ephemeral() -> URLSessionConfiguration {
        let cfg = devscope_ephemeral()
        cfg.protocolClasses = [DevScopeURLProtocol.self] + (cfg.protocolClasses ?? []).filter { $0 != DevScopeURLProtocol.self }
        return cfg
    }
}

// MARK: - Layout agent

final class DevScopeLayoutAgent {
    static let shared = DevScopeLayoutAgent()

    private var socket: URLSessionWebSocketTask?
    private var timer: Timer?
    private var lastHash = 0
    private var retryScheduled = false

    func start() {
        let transport = DevScopeTransport.shared
        if transport.baseURL != nil { connect() } else { transport.onReady = { [weak self] in self?.connect() } }
    }

    private func connect() {
        guard let base = DevScopeTransport.shared.baseURL,
              var comps = URLComponents(url: base, resolvingAgainstBaseURL: false) else { return }
        comps.scheme = "ws"
        comps.path = "/agent"
        guard let url = comps.url else { return }
        NSLog("DevScope: layout agent connecting to %@", url.absoluteString)
        let task = DevScopeReporter.session.webSocketTask(with: url)
        socket = task
        task.resume()
        var hello = DevScopeIdentity.common
        hello["type"] = "hello"
        send(hello)
        receive()
    }

    private func receive() {
        socket?.receive { [weak self] result in
            guard let self = self else { return }
            switch result {
            case .failure(let error):
                NSLog("DevScope: layout agent disconnected: %@", "\(error)")
                self.scheduleRetry()
            case .success(let message):
                if case .string(let text) = message,
                   let data = text.data(using: .utf8),
                   let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] {
                    self.handle(obj)
                }
                self.receive()
            }
        }
    }

    private func scheduleRetry() {
        guard !retryScheduled else { return }
        retryScheduled = true
        socket?.cancel(with: .goingAway, reason: nil)
        socket = nil
        DispatchQueue.main.async { self.setWatching(false, serial: "") }
        DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak self] in
            self?.retryScheduled = false
            self?.connect()
        }
    }

    private func handle(_ msg: [String: Any]) {
        let serial = msg["serial"] as? String ?? ""
        switch msg["type"] as? String {
        case "layout.dump":
            DispatchQueue.main.async { self.dump(serial: serial, force: true) }
        case "layout.watch":
            let on = msg["on"] as? Bool ?? false
            DispatchQueue.main.async { self.setWatching(on, serial: serial) }
        default:
            break
        }
    }

    /// Live mode: while a browser watches, re-send the tree whenever it changes (checked every 400 ms).
    private func setWatching(_ on: Bool, serial: String) {
        timer?.invalidate()
        timer = nil
        guard on else { return }
        timer = Timer.scheduledTimer(withTimeInterval: 0.4, repeats: true) { [weak self] _ in
            self?.dump(serial: serial, force: false)
        }
        dump(serial: serial, force: true)
    }

    private func dump(serial: String, force: Bool) {
        guard let window = Self.keyWindow() else {
            send(["type": "layout.error", "serial": serial, "error": "No key window in \(DevScopeIdentity.appId)."])
            return
        }
        let tree = Self.node(for: window, window: window)
        let hash = ((try? JSONSerialization.data(withJSONObject: tree)) ?? Data()).hashValue
        if !force && hash == lastHash { return }
        lastHash = hash
        var msg: [String: Any] = ["type": "layout.tree", "serial": serial, "tree": tree, "activity": Self.topViewControllerName(window)]
        if let png = Self.screenshot(window) { msg["screenshot"] = png.base64EncodedString() }
        send(msg)
    }

    private func send(_ obj: [String: Any]) {
        guard let socket = socket,
              let data = try? JSONSerialization.data(withJSONObject: obj),
              let text = String(data: data, encoding: .utf8) else { return }
        socket.send(.string(text)) { error in
            if let error = error { NSLog("DevScope: send failed: %@", "\(error)") }
        }
    }

    // MARK: tree

    static func keyWindow() -> UIWindow? {
        let windows = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap { $0.windows }
        return windows.first { $0.isKeyWindow } ?? windows.first { !$0.isHidden }
    }

    static func topViewControllerName(_ window: UIWindow) -> String {
        var vc = window.rootViewController
        while let presented = vc?.presentedViewController { vc = presented }
        if let nav = vc as? UINavigationController { vc = nav.topViewController ?? vc }
        if let tab = vc as? UITabBarController { vc = tab.selectedViewController ?? vc }
        return vc.map { String(describing: type(of: $0)) } ?? "?"
    }

    static func node(for view: UIView, window: UIWindow) -> [String: Any] {
        var o: [String: Any] = ["kind": "uikit", "type": String(describing: type(of: view))]
        if let id = view.accessibilityIdentifier, !id.isEmpty { o["id"] = id }
        if let text = text(of: view), !text.isEmpty { o["text"] = String(text.prefix(120)) }
        if let label = view.accessibilityLabel, !label.isEmpty, label != (o["text"] as? String) { o["desc"] = String(label.prefix(120)) }
        o["bounds"] = rect(view.convert(view.bounds, to: window))
        if view.isHidden || view.alpha < 0.01 { o["hidden"] = true }

        var children: [[String: Any]] = []
        if isHostingView(view) {
            // SwiftUI: walk what it publishes to accessibility (labels, identifiers, frames).
            children = accessibilityChildren(of: view, window: window, depth: 0)
        }
        if children.isEmpty {
            children = view.subviews.map { node(for: $0, window: window) }
        }
        if !children.isEmpty { o["children"] = children }
        return o
    }

    static func isHostingView(_ view: UIView) -> Bool {
        let name = String(describing: type(of: view))
        return name.contains("HostingView") || name.hasPrefix("_UIHosting")
    }

    static func accessibilityChildren(of container: NSObject, window: UIWindow, depth: Int) -> [[String: Any]] {
        guard depth < 40 else { return [] }
        var elements: [NSObject] = []
        if let list = container.accessibilityElements as? [NSObject] {
            elements = list
        } else {
            let count = container.accessibilityElementCount()
            if count != NSNotFound && count > 0 {
                for i in 0..<count {
                    if let element = container.accessibilityElement(at: i) as? NSObject { elements.append(element) }
                }
            }
        }
        return elements.map { element in
            var o: [String: Any] = ["kind": "swiftui", "type": traitName(element.accessibilityTraits)]
            if let id = (element as? UIAccessibilityIdentification)?.accessibilityIdentifier, !id.isEmpty { o["id"] = id }
            if let label = element.accessibilityLabel, !label.isEmpty { o["text"] = String(label.prefix(120)) }
            if let value = element.accessibilityValue, !value.isEmpty { o["desc"] = String(value.prefix(120)) }
            o["bounds"] = rect(window.convert(element.accessibilityFrame, from: nil))
            if let v = element as? UIView, v.isHidden || v.alpha < 0.01 { o["hidden"] = true }
            let kids = accessibilityChildren(of: element, window: window, depth: depth + 1)
            if !kids.isEmpty { o["children"] = kids }
            return o
        }
    }

    static func traitName(_ traits: UIAccessibilityTraits) -> String {
        if traits.contains(.button) { return "Button" }
        if traits.contains(.header) { return "Header" }
        if traits.contains(.link) { return "Link" }
        if traits.contains(.image) { return "Image" }
        if traits.contains(.searchField) { return "SearchField" }
        if traits.contains(.adjustable) { return "Adjustable" }
        if traits.contains(.tabBar) { return "TabBar" }
        if traits.contains(.staticText) { return "Text" }
        return "Element"
    }

    static func text(of view: UIView) -> String? {
        switch view {
        case let label as UILabel: return label.text
        case let button as UIButton: return button.currentTitle ?? button.titleLabel?.text
        case let field as UITextField: return field.isSecureTextEntry ? "••••••" : (field.text?.isEmpty == false ? field.text : field.placeholder)
        case let textView as UITextView: return textView.text
        default: return nil
        }
    }

    static func rect(_ r: CGRect) -> [Int] {
        [Int(r.minX.rounded()), Int(r.minY.rounded()), Int(r.width.rounded()), Int(r.height.rounded())]
    }

    /// Rendered at scale 1 so one image pixel == one point == the units used in `bounds`.
    static func screenshot(_ window: UIWindow) -> Data? {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let renderer = UIGraphicsImageRenderer(bounds: window.bounds, format: format)
        return renderer.pngData { _ in window.drawHierarchy(in: window.bounds, afterScreenUpdates: false) }
    }
}
#endif
