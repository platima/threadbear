import AppKit
import XCTest
@testable import Threadbear
@testable import ThreadbearCore

/// Where the Terminal panel's shell runs, and what it's handed. None of
/// these start a shell.
@MainActor
final class TerminalPanelTests: XCTestCase {
    private let home = NSHomeDirectory()

    func testNoThreadIsAShellInHome() {
        let target = TerminalTarget.for(nil) { _ in nil }
        XCTAssertEqual(target, TerminalTarget(key: "home", cwd: home))
    }

    func testALocalThreadGetsItsOwnShellInItsFolder() {
        let folder = FileManager.default.temporaryDirectory.path
        let thread = ThreadSummary(id: "t1", title: "Work", cwd: folder)
        let target = TerminalTarget.for(thread) { _ in nil }
        XCTAssertEqual(target, TerminalTarget(key: "t1", cwd: folder))
    }

    func testARemoteThreadSharesTheHomeShellAndSaysWhere() {
        var thread = ThreadSummary(id: "t2", title: "Elsewhere", cwd: FileManager.default.temporaryDirectory.path)
        thread.runnerId = "bruce"
        let target = TerminalTarget.for(thread) { _ in "bruce" }
        XCTAssertEqual(target.key, "home")
        XCTAssertEqual(target.cwd, home)
        XCTAssertEqual(target.note?.contains("on bruce"), true)
    }

    func testAThreadWhoseFolderHasGoneSharesTheHomeShell() {
        let thread = ThreadSummary(id: "t3", title: "Gone", cwd: "/no/such/folder/\(UUID().uuidString)")
        let target = TerminalTarget.for(thread) { _ in nil }
        XCTAssertEqual(target.key, "home")
        XCTAssertEqual(target.cwd, home)
        XCTAssertNotNil(target.note)
    }

    /// An archived thread's worktree may be another thread's now, so its
    /// terminal is the home one, never a shell in that folder.
    func testAnArchivedThreadSharesTheHomeShell() {
        let thread = ThreadSummary(id: "t4", title: "Done", cwd: FileManager.default.temporaryDirectory.path, archivedAt: Date())
        let target = TerminalTarget.for(thread) { _ in nil }
        XCTAssertEqual(target.key, "home")
        XCTAssertEqual(target.cwd, home)
        XCTAssertEqual(target.note?.contains("archived"), true)
    }

    /// `tb` reads a thread id as "I'm that thread's agent", so the shell
    /// must never have one, under either name.
    func testTheShellIsNeverHandedAThreadId() {
        let env = TerminalSession.environment(from: [
            "THREADBEAR_THREAD_ID": "abc", "THREADBARE_THREAD_ID": "abc", "PATH": "/usr/bin", "LANG": "",
        ])
        XCTAssertFalse(env.contains { $0.hasPrefix("THREADBEAR_THREAD_ID=") })
        XCTAssertFalse(env.contains { $0.hasPrefix("THREADBARE_THREAD_ID=") })
        XCTAssertTrue(env.contains("PATH=/usr/bin"))
        XCTAssertTrue(env.contains("TERM=xterm-256color"))
        XCTAssertTrue(env.contains("LANG=en_US.UTF-8"))
    }

    /// Looking at a thread with the panel open starts nothing; only `open`
    /// (⌘J, or a click on the empty panel) does.
    func testLookingStartsNoShell() {
        let terminals = Terminals()
        XCTAssertNil(terminals.existing(for: TerminalTarget(key: "t1", cwd: home)))
        XCTAssertTrue(terminals.debugSummary.isEmpty)
    }
}
