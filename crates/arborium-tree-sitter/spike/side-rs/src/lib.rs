#![no_std]

use core::ffi::c_void;

unsafe extern "C" {
    fn ts_parser_new() -> *mut c_void;
    fn ts_parser_reset(self_: *mut c_void);
    fn ts_parser_delete(self_: *mut c_void);
}

#[unsafe(no_mangle)]
pub extern "C" fn try_ts() -> usize {
    unsafe {
        let p = ts_parser_new();
        if p.is_null() {
            return 0;
        }
        ts_parser_reset(p);
        let addr = p as usize;
        ts_parser_delete(p);
        addr
    }
}

#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    loop {}
}
