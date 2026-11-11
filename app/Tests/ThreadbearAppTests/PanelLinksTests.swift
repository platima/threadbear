import Network
import WebKit
import XCTest
@testable import Threadbear
@testable import ThreadbearCore

/// A patch's url panel, in a real web view (Mike, 11 Nov): a click on a
/// video in the YouTube patch's page loaded YouTube in the panel with no
/// way back, and closing the panel left the video playing.
@MainActor
final class PanelLinksTests: XCTestCase {
    func testWhichLinksLeaveThePanel() {
        let home = URL(string: "http://127.0.0.1:6427/")!
        func leaves(_ s: String, click: Bool = true, main: Bool = true) -> Bool {
            WebPanelPool.leavesPanel(URL(string: s), home: home, linkClick: click, mainFrame: main)
        }
        XCTAssertTrue(leaves("https://www.youtube.com/watch?v=x"))
        XCTAssertTrue(leaves("http://localhost:6427/"), "another host is another site")
        XCTAssertTrue(leaves("http://127.0.0.1:6428/"), "and another port")
        XCTAssertFalse(leaves("http://127.0.0.1:6427/video/1"), "the patch's own pages stay")
        XCTAssertFalse(leaves("HTTP://127.0.0.1:6427/x"))
        XCTAssertFalse(leaves("https://www.youtube.com/", click: false), "a redirect or a sign-in's script stays")
        XCTAssertFalse(leaves("https://www.youtube.com/", main: false), "an iframe's own links stay in it")
        XCTAssertFalse(leaves("mailto:a@b.c"), "only web pages")
        XCTAssertTrue(WebPanelPool.sameSite(URL(string: "https://a.com/x")!, URL(string: "https://a.com:443/y")!))
    }

    /// Serves the panel's page and a looping tone, on this Mac.
    private final class Site: @unchecked Sendable {
        let listener: NWListener
        var port: UInt16 { listener.port?.rawValue ?? 0 }
        var page = ""

        init() throws {
            listener = try NWListener(using: .tcp, on: .any)
            listener.newConnectionHandler = { [weak self] connection in
                connection.start(queue: .global())
                connection.receive(minimumIncompleteLength: 1, maximumLength: 8192) { data, _, _, _ in
                    let line = data.flatMap { String(data: $0, encoding: .utf8)?.components(separatedBy: "\r\n").first } ?? ""
                    let (type, body): (String, Data) = line.contains("/tone.wav")
                        ? ("audio/wav", Self.tone) : ("text/html", Data((self?.page ?? "").utf8))
                    var reply = Data("HTTP/1.1 200 OK\r\nContent-Type: \(type)\r\nContent-Length: \(body.count)\r\nConnection: close\r\n\r\n".utf8)
                    reply.append(body)
                    connection.send(content: reply, completion: .contentProcessed { _ in connection.cancel() })
                }
            }
        }

        func start() async throws {
            listener.start(queue: .global())
            for _ in 0..<50 where listener.port == nil || listener.state != .ready { try await Task.sleep(for: .milliseconds(20)) }
        }

        /// Two seconds of a quiet 440 Hz tone, 8 kHz mono 16-bit.
        static let tone: Data = {
            let rate = 8000, count = rate * 2
            var d = Data()
            func u32(_ v: Int) { var x = UInt32(v).littleEndian; d.append(Data(bytes: &x, count: 4)) }
            func u16(_ v: Int) { var x = UInt16(v).littleEndian; d.append(Data(bytes: &x, count: 2)) }
            d.append(Data("RIFF".utf8)); u32(36 + count * 2); d.append(Data("WAVEfmt ".utf8))
            u32(16); u16(1); u16(1); u32(rate); u32(rate * 2); u16(2); u16(16)
            d.append(Data("data".utf8)); u32(count * 2)
            for i in 0..<count {
                var s = Int16(sin(Double(i) * 2 * .pi * 440 / Double(rate)) * 2000).littleEndian
                d.append(Data(bytes: &s, count: 2))
            }
            return d
        }()

        deinit { listener.cancel() }
    }

    private func waitFor(_ what: String, _ check: () async -> Bool) async throws {
        for _ in 0..<100 {
            if await check() { return }
            try await Task.sleep(for: .milliseconds(100))
        }
        XCTFail("never: \(what)")
    }

    private func js(_ body: String, in view: WKWebView) async throws -> Any? {
        try await view.callAsyncJavaScript(body, contentWorld: .page)
    }

    func testLinksOffThePanelsSiteOpenOutsideAndItsOwnHaveBack() async throws {
        let site = try Site()
        try await site.start()
        let home = URL(string: "http://127.0.0.1:\(site.port)/")!
        let other = "http://localhost:\(site.port)"
        site.page = """
        <!doctype html><html><head><title>patch</title></head><body>
        <a id="video" href="\(other)/watch">video</a>
        <a id="blank" target="_blank" href="\(other)/blank">blank</a>
        <a id="own" href="/second">own</a>
        <form id="form" method="get" action="\(other)/form"><input name="q" value="x"></form>
        </body></html>
        """
        let pool = WebPanelPool(defaults: UserDefaults(suiteName: "PanelLinksTests.\(UUID().uuidString)")!)
        let view = pool.webView(for: home)
        var opened: [String] = []
        pool.setLeaving((home, { opened.append($0.absoluteString) }), for: view)
        try await waitFor("the page loads") { !view.isLoading && view.url == home }

        _ = try await js("document.getElementById('video').click()", in: view)
        try await waitFor("the video opens outside") { opened.contains("\(other)/watch") }
        _ = try await js("document.getElementById('blank').click()", in: view)
        try await waitFor("the new-tab link opens outside") { opened.contains("\(other)/blank") }
        // A button's window.open and a form to another site (Codex review).
        _ = try await js("window.open('\(other)/popup')", in: view)
        try await waitFor("window.open opens outside") { opened.contains("\(other)/popup") }
        _ = try await js("document.getElementById('form').submit()", in: view)
        try await waitFor("the form opens outside") { opened.contains { $0.hasPrefix("\(other)/form") } }
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertEqual(view.url, home, "the patch's page stayed")
        XCTAssertEqual(opened.count, 4, "each opened once: \(opened)")
        XCTAssertFalse(pool.canGoBack(home))

        // Its own link loads in the panel, and Back comes back.
        _ = try await js("document.getElementById('own').click()", in: view)
        try await waitFor("its own page loads") { view.url?.path == "/second" && !view.isLoading }
        XCTAssertTrue(pool.canGoBack(home))
        pool.goBack(home)
        try await waitFor("Back") { view.url == home }
    }

    /// Closing the panel (or picking another thread) takes the view out of
    /// the window; the pool keeps it, and its sound stops.
    func testAClosedPanelsMediaPauses() async throws {
        let site = try Site()
        try await site.start()
        let home = URL(string: "http://127.0.0.1:\(site.port)/")!
        site.page = #"<!doctype html><html><body><audio id="a" loop src="/tone.wav"></audio></body></html>"#
        let pool = WebPanelPool(defaults: UserDefaults(suiteName: "PanelLinksTests.\(UUID().uuidString)")!)
        let view = pool.webView(for: home)
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 400, height: 300), styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        let container = WebPanelContainer(frame: window.contentView!.bounds)
        window.contentView!.addSubview(container)
        container.show(view)
        try await waitFor("the page loads") { !view.isLoading && view.url == home }
        _ = try await js("const a = document.getElementById('a'); a.muted = true; await a.play()", in: view)
        try await waitFor("it plays") { (try? await self.js("return document.getElementById('a').paused", in: view)) as? Bool == false }

        // Moving it to another panel's container doesn't pause it.
        let next = WebPanelContainer(frame: window.contentView!.bounds)
        window.contentView!.addSubview(next)
        next.show(view)
        try await Task.sleep(for: .milliseconds(300))
        let moved = try await js("return document.getElementById('a').paused", in: view) as? Bool
        XCTAssertEqual(moved, false)

        // Closing it does, and the page's own script can't start it again
        // unseen (Codex review).
        _ = try await js("const a = document.getElementById('a'); a.addEventListener('pause', () => setTimeout(() => a.play().catch(() => {}), 100))", in: view)
        next.removeFromSuperview()
        try await waitFor("it pauses") { (try? await self.js("return document.getElementById('a').paused", in: view)) as? Bool == true }
        try await Task.sleep(for: .milliseconds(800))
        let restarted = try await js("return document.getElementById('a').paused", in: view) as? Bool
        XCTAssertEqual(restarted, true, "the page started it again")
        window.close()
    }
}
