import AppKit
import XCTest
@testable import Threadbear
import ThreadbearCore

/// A ```bash block gets play and copy icons, drawn with its box.
@MainActor
final class ShellBlockRenderTests: XCTestCase {
    private func transcript(_ markdown: String, width: CGFloat = 500) -> TranscriptTextView {
        let view = TranscriptTextView()
        view.frame = NSRect(x: 0, y: 0, width: width, height: 400)
        view.show(MarkdownRenderer.render(markdown).string, width: width)
        return view
    }

    private func command(in view: TranscriptTextView, at text: String) throws -> String? {
        let storage = try XCTUnwrap(view.textStorage)
        let index = (storage.string as NSString).range(of: text).location
        XCTAssertNotEqual(index, NSNotFound)
        return storage.attribute(.tbShellBlock, at: index, effectiveRange: nil) as? String
    }

    /// The middle of an icon, found from its tip's anchor as the pointer would.
    private func point(of icon: ShellBlockIcons.Icon, in view: TranscriptTextView) throws -> NSPoint {
        let anchor = try XCTUnwrap(view.subviews.compactMap { $0 as? RichTipAnchor }.first { $0.text == icon.tip })
        return NSPoint(x: anchor.frame.midX, y: anchor.frame.midY)
    }

    func testOnlyAClosedShellFenceIsPressable() throws {
        XCTAssertEqual(try command(in: transcript("Run:\n\n```bash\nnpm test\n```"), at: "npm test"), "npm test")
        // Still streaming: half a command mustn't have a play icon.
        XCTAssertNil(try command(in: transcript("Run:\n\n```bash\nrm -rf build"), at: "rm -rf build"))
        XCTAssertNil(try command(in: transcript("```swift\nlet a = 1\n```"), at: "let a"))
        XCTAssertNil(try command(in: transcript("```\nnpm test\n```"), at: "npm test"))
    }

    func testALongCommandWrapsBeforeTheIconsAndTheBoxStillReachesTheEdge() throws {
        let long = String(repeating: "abcdefghij ", count: 30).trimmingCharacters(in: .whitespaces)
        let view = transcript("```bash\n\(long)\n```\n\n```text\n\(long)\n```")
        let manager = try XCTUnwrap(view.layoutManager as? BackgroundLayoutManager)
        let storage = try XCTUnwrap(view.textStorage)
        let container = try XCTUnwrap(view.textContainer)
        manager.ensureLayout(for: container)
        var shell = NSRange(), plain = NSRange()
        // Not 0: a reply that opens with a code block starts with a spacer.
        let first = (storage.string as NSString).range(of: long).location
        _ = storage.attribute(.tbBlockBackground, at: first, longestEffectiveRange: &shell, in: NSRange(location: 0, length: storage.length))
        let after = (storage.string as NSString).range(of: long, options: .backwards).location
        _ = storage.attribute(.tbBlockBackground, at: after, longestEffectiveRange: &plain, in: NSRange(location: 0, length: storage.length))
        let shellBox = try XCTUnwrap(manager.blockBox(shell, in: storage, width: container.size.width))
        let plainBox = try XCTUnwrap(manager.blockBox(plain, in: storage, width: container.size.width))
        XCTAssertEqual(shellBox.maxX, plainBox.maxX, accuracy: 0.5)
        var textRight: CGFloat = 0
        manager.enumerateLineFragments(forGlyphRange: manager.glyphRange(forCharacterRange: shell, actualCharacterRange: nil)) { _, used, _, _, _ in
            textRight = max(textRight, used.maxX)
        }
        let copy = ShellBlockIcons.rect(.copy, in: shellBox)
        let put = ShellBlockIcons.rect(.put, in: shellBox)
        XCTAssertLessThanOrEqual(textRight, put.minX)
        XCTAssertFalse(put.intersects(copy))
        XCTAssertLessThan(copy.maxX, shellBox.maxX)
    }

    func testClickingCopyCopiesTheCommand() throws {
        let board = NSPasteboard(name: NSPasteboard.Name("ShellBlockRenderTests-\(UUID())"))
        ShellBlockIcons.pasteboard = board
        addTeardownBlock { ShellBlockIcons.pasteboard = .general; board.releaseGlobally() }
        let command = "npx convex run --prod \(UUID())"
        let view = transcript("Yours:\n\n```bash\n\(command)\n```")
        let at = try point(of: .copy, in: view)
        let hit = try XCTUnwrap(view.shellIcon(at: at))
        XCTAssertEqual(hit.icon, .copy)
        let click = try XCTUnwrap(NSEvent.mouseEvent(with: .leftMouseDown, location: view.convert(at, to: nil), modifierFlags: [], timestamp: 0,
                                                     windowNumber: 0, context: nil, eventNumber: 0, clickCount: 1, pressure: 1))
        view.mouseDown(with: click)
        XCTAssertEqual(board.string(forType: .string), command)
        XCTAssertTrue(ShellBlockIcons.wasJustPressed(.copy, command))
        XCTAssertNotNil(view.subviews.first { $0 is CopiedBubble })
    }

    /// No shell here is the thread's own (no thread is open, like one on
    /// another runner), so there's no play icon to press, only Copy.
    func testNoPlayIconWhereTheTerminalWouldBeElsewhere() throws {
        XCTAssertFalse(AppModel.shared.canPutInTerminal)
        let view = transcript("```bash\nls\n```")
        XCTAssertNil(view.subviews.compactMap { $0 as? RichTipAnchor }.first { $0.text == ShellBlockIcons.Icon.put.tip })
    }

    func testIconsSitTopRightAndClearOfEachOther() {
        let box = NSRect(x: 10, y: 20, width: 400, height: 42)
        let copy = ShellBlockIcons.rect(.copy, in: box)
        let put = ShellBlockIcons.rect(.put, in: box)
        XCTAssertLessThanOrEqual(put.maxX, copy.minX)
        XCTAssertEqual(copy.midY, put.midY)
        XCTAssertTrue(box.contains(copy) && box.contains(put))
    }
}
