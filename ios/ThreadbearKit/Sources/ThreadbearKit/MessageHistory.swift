import Foundation

/// A thread's messages on the phone (backend API 2), as far back as you've
/// scrolled: the newest ones live from phone:messages, and older chunks asked
/// for once each with beforeSeq.
///
/// The live page stays the size it opened with. It used to grow by raising
/// its limit as you scrolled back, up to 2,000 rows, and a live query reads
/// its whole page again for every new message: a scrolled-back phone on the
/// launch thread cost 37.6 MB of Convex I/O in a day (8 Nov), more than a
/// free plan's daily share. Older rows come in chunks from where the shown
/// ones begin, read once, since past messages don't change.
public struct MessageHistory: Sendable, Equatable {
    /// The most rows one phone:messages query returns (PAGE_MAX in convex/phone.ts).
    public static let liveMax = 2000

    /// The newest messages, live.
    public private(set) var live: MessagePage?
    /// Older messages from chunks, oldest first, all before `live`'s.
    public private(set) var older: [PhoneMessage] = []
    public private(set) var olderImages: [MessageImage] = []
    /// Whether there's more before `older`; nil until a chunk has come.
    public private(set) var olderHasMore: Bool?
    /// Pictures from phone:images (API 37) from `older`'s first row on: one
    /// that finishes uploading after its row was read (into a chunk, or off
    /// the live page's top) comes only from there.
    public private(set) var lateImages: [MessageImage] = []

    public init() {}

    public var messages: [PhoneMessage] { older + (live?.messages ?? []) }

    /// The pictures of every row shown, each once.
    public var images: [MessageImage] {
        var seen = Set<String>()
        let shown = Set(messages.map(\.seq))
        return (olderImages + (live?.images ?? []) + lateImages.filter { shown.contains($0.seq) }).filter { seen.insert($0.url).inserted }
    }

    public var hasMore: Bool { olderHasMore ?? (live?.hasMore ?? false) }

    public var firstSeq: Int? { older.first?.seq ?? live?.messages.first?.seq }

    /// A new value of the live query. Rows that slide off its top as new ones
    /// come in move to `older`, or there'd be a hole above the live ones.
    public mutating func takeLive(_ page: MessagePage) {
        if let old = live, let first = page.messages.first?.seq {
            if let last = old.messages.last?.seq, last < first {
                // Nothing in common with the page before (the phone was away
                // while a whole page of new messages came): what's between
                // them is unknown, so start again from the newest rather
                // than show a hole.
                self = MessageHistory()
            } else {
                // Its top can also move back up (big rows above the byte cap
                // that got smaller): those rows are the live page's again.
                older.removeAll { $0.seq >= first }
                olderImages.removeAll { $0.seq >= first }
                let after = older.last?.seq ?? Int.min
                older += old.messages.filter { $0.seq < first && $0.seq > after }
                olderImages += old.images.filter { $0.seq < first && $0.seq > after }
            }
        }
        live = page
    }

    /// Where phone:images should watch from: the first row read once, or
    /// nil while the live page is all there is.
    public var lateImagesFrom: Int? { older.first?.seq }

    public mutating func takeLateImages(_ images: [MessageImage]) { lateImages = images }

    /// The seq to ask for an older chunk before, or nil when there's no more.
    public var nextBefore: Int? { hasMore ? firstSeq : nil }

    /// A chunk of rows before `seq`. False, and nothing changes, if the
    /// shown rows no longer start there (it came too late).
    @discardableResult
    public mutating func takeOlder(_ chunk: MessagePage, before seq: Int) -> Bool {
        guard seq == firstSeq else { return false }
        older = chunk.messages.filter { $0.seq < seq } + older
        olderImages = chunk.images.filter { $0.seq < seq } + olderImages
        olderHasMore = chunk.hasMore
        return true
    }
}
