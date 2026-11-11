import Foundation

/// The sidebar's Projects view with the projectDecisions experiment on: one
/// row per project, folded by default, its threads under it only while it's
/// open (Mike, 11 Nov 2026: "one row per project which can be expanded and
/// contracted"). "Not in a project" folds the same way. Which are open is
/// kept by id across launches (AppModel.openProjectRows).
public enum ProjectFolds {
    /// "Not in a project"'s id among the open ones.
    public static let unfiledId = "-"

    /// Thread ids top to bottom as the folded list shows them, for the arrow
    /// keys: only open projects' threads, each thread once.
    public static func order(_ sections: ProjectSections, open: Set<String>) -> [String] {
        var seen = Set<String>()
        let shown = sections.sections.filter { open.contains($0.id) }.flatMap(\.threads)
            + (open.contains(unfiledId) ? sections.unfiled : [])
        return shown.map(\.id).filter { seen.insert($0).inserted }
    }

    /// What's drawn, a row id each (project rows as "p:<id>", threads as
    /// "<section>/<thread>"), so the list animates a project opening or
    /// closing as rows coming and going.
    public static func layout(_ sections: ProjectSections, open: Set<String>) -> [String] {
        var rows: [String] = []
        for section in sections.sections {
            rows.append("p:" + section.id)
            if open.contains(section.id) { rows += section.threads.map { section.id + "/" + $0.id } }
        }
        if !sections.unfiled.isEmpty {
            rows.append("p:" + unfiledId)
            if open.contains(unfiledId) { rows += sections.unfiled.map { unfiledId + "/" + $0.id } }
        }
        return rows
    }
}
