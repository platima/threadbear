// The icons the app draws in place of SF Symbols, which can't ship outside
// Apple's systems. Lucide comes with gpui-kit's assets; main.rs registers
// `AllAssets`, so any Lucide icon can be named here. This is the one place
// that maps Swift's symbol names to a bundled icon: add a line when a view
// needs a new one. A symbol with no match draws a question mark, which is
// easy to spot in a screenshot; a project's own icon falls back to its letter
// instead (see `try_symbol`).
use gpui_kit::assets::IconName;
use gpui_kit::component::Icon;

/// `star.fill` has no Lucide twin (Lucide's stars are outlines), so it's drawn
/// here: the star's shape, filled with the current text colour.
const STAR_FILLED: &[u8] = br#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M12 2.5l2.9 6.4 7 .7-5.2 4.7 1.5 6.9L12 17.7l-6.2 3.5 1.5-6.9-5.2-4.7 7-.7z" fill="black"/></svg>"#;

/// The bundled icon for one of the app's SF Symbol names.
pub fn symbol(name: &str) -> Icon {
    try_symbol(name).unwrap_or_else(|| Icon::new(IconName::CircleQuestionMark))
}

/// The bundled icon for an SF Symbol name, if there is one yet.
pub fn try_symbol(name: &str) -> Option<Icon> {
    let lucide = match name {
        "star" => IconName::Star,
        "star.fill" => return Some(Icon::default().data(STAR_FILLED)),
        "star.slash" => IconName::StarOff,
        "tray" => IconName::Inbox,
        "tray.and.arrow.up" => IconName::ArchiveRestore,
        "bolt" => IconName::Zap,
        "moon" | "moon.zzz" => IconName::Moon,
        "archivebox" => IconName::Archive,
        "arrow.uturn.backward" => IconName::Undo2,
        "trash" => IconName::Trash,
        "sun.max" => IconName::Sun,
        "folder" => IconName::Folder,
        "square.and.pencil" => IconName::SquarePen,
        "magnifyingglass" => IconName::Search,
        "xmark.circle.fill" | "xmark.circle" => IconName::CircleX,
        "hand.raised" => IconName::Hand,
        "arrow.down" => IconName::ArrowDown,
        "arrow.up" => IconName::ArrowUp,
        "arrow.up.arrow.down" => IconName::ArrowUpDown,
        "ellipsis" => IconName::Ellipsis,
        "chevron.down" => IconName::ChevronDown,
        "chevron.right" => IconName::ChevronRight,
        "checkmark" => IconName::Check,
        "xmark" => IconName::X,
        "minus" => IconName::Minus,
        "clock" => IconName::Clock,
        "sunset" => IconName::Sunset,
        "sunrise" => IconName::Sunrise,
        "briefcase" => IconName::Briefcase,
        "calendar" => IconName::Calendar,
        "text.bubble" => IconName::MessageSquareText,
        "arrow.clockwise" => IconName::RotateCw,
        "pawprint" => IconName::PawPrint,
        "books.vertical" => IconName::Library,
        "bell" => IconName::Bell,
        "wrench.and.screwdriver" => IconName::Wrench,
        "hammer" => IconName::Hammer,
        "number" => IconName::Hash,
        "pencil" => IconName::Pencil,
        "rectangle.split.2x1" => IconName::Columns2,
        "square.stack" => IconName::Layers,
        "plus" => IconName::Plus,
        "desktopcomputer" => IconName::Monitor,
        "macmini" => IconName::Server,
        "ladybug" | "ant" => IconName::Bug,
        "externaldrive" => IconName::HardDrive,
        // The symbols Settings › Pools and the librarian offer for a project
        // (`Pools.iconChoices`).
        "photo" => IconName::Image,
        "sparkle" => IconName::Sparkle,
        "chevron.left.forwardslash.chevron.right" => IconName::CodeXml,
        "house" => IconName::House,
        "paintbrush" => IconName::Paintbrush,
        "film" => IconName::Film,
        "book" => IconName::Book,
        "graduationcap" => IconName::GraduationCap,
        "leaf" => IconName::Leaf,
        "flame" => IconName::Flame,
        "heart" => IconName::Heart,
        "flag" => IconName::Flag,
        "bookmark" => IconName::Bookmark,
        "tag" => IconName::Tag,
        "globe" => IconName::Globe,
        "building.2" => IconName::Building2,
        "cart" => IconName::ShoppingCart,
        "gamecontroller" => IconName::Gamepad2,
        "music.note" => IconName::Music,
        "camera" => IconName::Camera,
        "airplane" => IconName::Plane,
        "cup.and.saucer" => IconName::Coffee,
        _ => return None,
    };
    Some(Icon::new(lucide))
}
