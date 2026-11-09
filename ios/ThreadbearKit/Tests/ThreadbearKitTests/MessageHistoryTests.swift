import Foundation
import Testing
@testable import ThreadbearKit

@Suite struct MessageHistoryTests {
    let t0 = Date(timeIntervalSince1970: 1_800_000_000)
    func page(_ seqs: ClosedRange<Int>, hasMore: Bool, images: [Int] = []) -> MessagePage {
        MessagePage(messages: seqs.map { PhoneMessage(seq: $0, role: $0 % 2 == 0 ? .assistant : .user, text: "m\($0)", at: t0) },
                    hasMore: hasMore,
                    images: images.map { MessageImage(seq: $0, url: "https://x/\($0).png") })
    }

    /// The live page never grows: "Load earlier" reads a chunk before it,
    /// once, rather than asking the live query for more rows to read again
    /// on every new message (37.6 MB of Convex I/O on 8 Nov).
    @Test func loadEarlierAsksForAChunkNotABiggerLivePage() {
        var h = MessageHistory()
        #expect(h.nextBefore == nil)
        h.takeLive(page(921...1000, hasMore: true))
        #expect(h.nextBefore == 921)
        var all = MessageHistory()
        all.takeLive(page(1...80, hasMore: false))
        #expect(all.nextBefore == nil)
    }

    @Test func chunksGoAboveTheLivePageUntilTheStart() {
        var h = MessageHistory()
        h.takeLive(page(7421...7500, hasMore: true))
        let took1 = h.takeOlder(page(7221...7420, hasMore: true, images: [7310]), before: 7421)
        #expect(took1)
        #expect(h.messages.map(\.seq) == Array(7221...7500))
        #expect(h.nextBefore == 7221)
        let took2 = h.takeOlder(page(1...7220, hasMore: false), before: 7221)
        #expect(took2)
        #expect(h.messages.count == 7500)
        #expect(!h.hasMore)
        #expect(h.nextBefore == nil)
        #expect(h.images.map(\.seq) == [7310])
    }

    /// New messages slide the oldest off the live page. Those rows stay, or
    /// there'd be a hole above the live ones, before any chunk too: you may be
    /// reading them.
    @Test func rowsThatSlideOffTheLivePageStay() {
        var h = MessageHistory()
        h.takeLive(page(921...1000, hasMore: true, images: [921]))
        h.takeLive(page(922...1001, hasMore: true))
        #expect(h.messages.map(\.seq) == Array(921...1001))
        // Two more while a chunk was on its way.
        h.takeLive(page(924...1003, hasMore: true))
        #expect(h.firstSeq == 921)
        let took = h.takeOlder(page(721...920, hasMore: true), before: 921)
        #expect(took)
        #expect(h.messages.map(\.seq) == Array(721...1003))
        #expect(h.images.map(\.seq) == [921])
        // And again, after the chunk.
        h.takeLive(page(925...1004, hasMore: true))
        #expect(h.messages.map(\.seq) == Array(721...1004))
    }

    /// A chunk asked for before rows that are no longer the first is dropped.
    @Test func aLateChunkIsDropped() {
        var h = MessageHistory()
        h.takeLive(page(921...1000, hasMore: true))
        let took4 = h.takeOlder(page(721...920, hasMore: true), before: 921)
        #expect(took4)
        let took5 = h.takeOlder(page(721...920, hasMore: true), before: 921)
        #expect(!took5)
        #expect(h.messages.count == 280)
    }

    /// Away long enough for a whole page of new messages: what came between
    /// is unknown, so it starts again from the newest rather than show a hole.
    @Test func noOverlapWithThePageBeforeStartsAgain() {
        var h = MessageHistory()
        h.takeLive(page(921...1000, hasMore: true))
        let took = h.takeOlder(page(721...920, hasMore: true), before: 921)
        #expect(took)
        h.takeLive(page(1101...1180, hasMore: true))
        #expect(h.messages.map(\.seq) == Array(1101...1180))
        #expect(h.nextBefore == 1101)
    }

    /// The live page's top moving back up (big rows that got smaller) takes
    /// its rows back from the chunks: nothing shows twice.
    @Test func aLivePageReachingFurtherBackTakesItsRowsBack() {
        var h = MessageHistory()
        h.takeLive(page(921...1000, hasMore: true, images: [925]))
        h.takeLive(page(931...1010, hasMore: true))
        h.takeLive(page(910...1010, hasMore: true, images: [925]))
        #expect(h.messages.map(\.seq) == Array(910...1010))
        #expect(h.images.map(\.seq) == [925])
    }

    /// A picture that finishes uploading after its row slid off the live
    /// page (or came in a chunk) arrives only from phone:images: it shows, and
    /// pictures for rows not shown don't.
    @Test func latePicturesOfRowsReadOnceShow() {
        var h = MessageHistory()
        #expect(h.lateImagesFrom == nil)
        h.takeLive(page(921...1000, hasMore: true))
        h.takeLive(page(925...1004, hasMore: true))
        #expect(h.lateImagesFrom == 921)
        h.takeLateImages([MessageImage(seq: 922, url: "https://x/922.png"), MessageImage(seq: 900, url: "https://x/900.png"), MessageImage(seq: 1001, url: "https://x/1001.png")])
        #expect(h.images.map(\.seq).sorted() == [922, 1001])
    }
}
