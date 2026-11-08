// No console window behind a desktop build (this crate is for Android; a desktop
// build is only for checking that it compiles).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    threadbear_android_lib::run()
}
