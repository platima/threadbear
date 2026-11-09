// What the desktop app knows with no window in sight, a port of the Swift
// app's ThreadbearCore: the inbox's rules and how a thread's events become
// rows. Keeping it out of the GPUI crate means its tests need no graphics
// libraries and take seconds.
pub mod inbox;
pub mod transcript;
pub mod reducer;
