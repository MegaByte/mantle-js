// cdt.rs — variant (C) of probes/_wasmCdtBench.mjs: the SAME flat Bowyer-Watson
// as the JS "js-flat" variant, in Rust, compiled to wasm32-unknown-unknown with
// raw rustc (no wasm-bindgen / no wasm-pack / no allocator).
//
// #![no_std], no allocator: all working memory is fixed-size `static mut` arrays
// in linear memory. JS writes points through ptsPtr() and reads triangles back
// through outPtr() as views on the exported `memory`.
//
// PREDICATES: plain-double (non-robust), byte-for-byte the same formulas as the
// two JS variants, so this bench isolates layout/runtime rather than predicate
// implementation. See the header of _wasmCdtBench.mjs.

#![no_std]
#![allow(non_snake_case)]

use core::panic::PanicInfo;
use core::ptr::addr_of_mut;

#[panic_handler]
fn panic(_info: &PanicInfo) -> ! {
    loop {}
}

const MAXP: usize = 20003; // 20000 input points + 3 super-triangle verts
const MAXT: usize = 90000; // triangle slots
const EMCAP: usize = 1 << 19; // edge hash capacity (power of two)
const EMMASK: usize = EMCAP - 1;

static mut PTS: [f64; MAXP * 2] = [0.0; MAXP * 2];
static mut TRI: [i32; MAXT * 3] = [0; MAXT * 3];
static mut ALIVE: [u8; MAXT] = [0; MAXT];
static mut FREE: [i32; MAXT] = [0; MAXT];
static mut BAD: [i32; MAXT] = [0; MAXT];
static mut STK: [i32; MAXT] = [0; MAXT];
static mut TOUCH: [i32; MAXT * 3] = [0; MAXT * 3];
static mut OUT: [i32; MAXT * 3] = [0; MAXT * 3];

// Edge hash: open addressing, linear probing, keys never removed (an entry whose
// count drops to 0 is exactly the JS `em.delete(k)` case — lookups return -1).
static mut EK: [u64; EMCAP] = [0; EMCAP]; // stored key + 1; 0 = empty
static mut ES0: [i32; EMCAP] = [0; EMCAP];
static mut ES1: [i32; EMCAP] = [0; EMCAP];
static mut ECN: [i32; EMCAP] = [0; EMCAP];
static mut ECT: [i32; EMCAP] = [0; EMCAP]; // per-insertion boundary edge count
static mut EFU: [i32; EMCAP] = [0; EMCAP];
static mut EFV: [i32; EMCAP] = [0; EMCAP];
static mut EUSED: [i32; EMCAP] = [0; EMCAP];

static mut NUSED: usize = 0;
static mut OVERFLOW: i32 = 0;

#[no_mangle]
pub extern "C" fn ptsPtr() -> *mut f64 {
    unsafe { addr_of_mut!(PTS) as *mut f64 }
}

#[no_mangle]
pub extern "C" fn outPtr() -> *mut i32 {
    unsafe { addr_of_mut!(OUT) as *mut i32 }
}

#[no_mangle]
pub extern "C" fn overflowed() -> i32 {
    unsafe { OVERFLOW }
}

#[no_mangle]
pub extern "C" fn maxPoints() -> i32 {
    (MAXP - 3) as i32
}

#[inline(always)]
fn hash(a: i32, b: i32) -> usize {
    let mut h = (a as u32).wrapping_mul(0x9E37_79B1) ^ (b as u32).wrapping_mul(0x85EB_CA77);
    h ^= h >> 16;
    h = h.wrapping_mul(0x7FEB_352D);
    h ^= h >> 15;
    (h as usize) & EMMASK
}

// CCW-positive orientation, plain double (predicates.js returns `-det` of the
// CW-positive determinant; we mirror that sign convention exactly).
#[inline(always)]
unsafe fn orient2d(pts: *const f64, a: i32, b: i32, c: i32) -> f64 {
    let (a, b, c) = (a as usize * 2, b as usize * 2, c as usize * 2);
    let (ax, ay) = (*pts.add(a), *pts.add(a + 1));
    let (bx, by) = (*pts.add(b), *pts.add(b + 1));
    let (cx, cy) = (*pts.add(c), *pts.add(c + 1));
    -((ay - cy) * (bx - cx) - (ax - cx) * (by - cy))
}

// Standard 3x3 in-circle determinant, plain double.
#[inline(always)]
unsafe fn incircle(pts: *const f64, a: i32, b: i32, c: i32, d: i32) -> f64 {
    let (a, b, c, d) = (a as usize * 2, b as usize * 2, c as usize * 2, d as usize * 2);
    let (dx, dy) = (*pts.add(d), *pts.add(d + 1));
    let (adx, ady) = (*pts.add(a) - dx, *pts.add(a + 1) - dy);
    let (bdx, bdy) = (*pts.add(b) - dx, *pts.add(b + 1) - dy);
    let (cdx, cdy) = (*pts.add(c) - dx, *pts.add(c + 1) - dy);
    let bdxcdy = bdx * cdy;
    let cdxbdy = cdx * bdy;
    let cdxady = cdx * ady;
    let adxcdy = adx * cdy;
    let adxbdy = adx * bdy;
    let bdxady = bdx * ady;
    let alift = adx * adx + ady * ady;
    let blift = bdx * bdx + bdy * bdy;
    let clift = cdx * cdx + cdy * cdy;
    alift * (bdxcdy - cdxbdy) + blift * (cdxady - adxcdy) + clift * (adxbdy - bdxady)
}

struct Em {
    ek: *mut u64,
    es0: *mut i32,
    es1: *mut i32,
    ecn: *mut i32,
}

#[inline(always)]
unsafe fn eslot(em: &Em, a: i32, b: i32, create: bool) -> i32 {
    let (u, v) = if a < b { (a, b) } else { (b, a) };
    let key = (((u as u32) as u64) << 32) | ((v as u32) as u64);
    let mut i = hash(u, v);
    loop {
        let k = *em.ek.add(i);
        if k == 0 {
            if !create {
                return -1;
            }
            *em.ek.add(i) = key + 1;
            *em.es0.add(i) = -1;
            *em.es1.add(i) = -1;
            *em.ecn.add(i) = 0;
            *addr_of_mut!(ECT).cast::<i32>().add(i) = 0;
            *addr_of_mut!(EUSED).cast::<i32>().add(NUSED) = i as i32;
            NUSED += 1;
            return i as i32;
        }
        if k == key + 1 {
            return i as i32;
        }
        i = (i + 1) & EMMASK;
    }
}

#[inline(always)]
unsafe fn add_te(em: &Em, s: i32, t: i32) {
    let s = s as usize;
    let cn = *em.ecn.add(s);
    if cn == 0 {
        *em.es0.add(s) = t;
    } else if cn == 1 {
        *em.es1.add(s) = t;
    } else {
        OVERFLOW = 1;
        return;
    }
    *em.ecn.add(s) = cn + 1;
}

#[inline(always)]
unsafe fn rem_te(em: &Em, s: i32, t: i32) {
    let s = s as usize;
    let cn = *em.ecn.add(s);
    if cn == 1 {
        if *em.es0.add(s) == t {
            *em.ecn.add(s) = 0;
        }
    } else if cn == 2 {
        if *em.es0.add(s) == t {
            *em.es0.add(s) = *em.es1.add(s);
            *em.ecn.add(s) = 1;
        } else if *em.es1.add(s) == t {
            *em.ecn.add(s) = 1;
        }
    }
}

#[inline(always)]
unsafe fn nbr(em: &Em, u: i32, v: i32, t: i32) -> i32 {
    let s = eslot(em, u, v, false);
    if s < 0 {
        return -1;
    }
    let s = s as usize;
    let cn = *em.ecn.add(s);
    if cn == 0 {
        return -1;
    }
    if *em.es0.add(s) == t {
        if cn > 1 {
            *em.es1.add(s)
        } else {
            -1
        }
    } else {
        *em.es0.add(s)
    }
}

/// Triangulate the first `n` points written at ptsPtr(). Returns the triangle
/// count; triangles are written to outPtr() as 3 i32 per triangle.
#[no_mangle]
pub extern "C" fn run(n: i32) -> i32 {
    unsafe { run_impl(n) }
}

unsafe fn run_impl(n: i32) -> i32 {
    let n = n as usize;
    OVERFLOW = 0;
    if n < 3 || n > MAXP - 3 {
        return -1;
    }
    let pts = addr_of_mut!(PTS).cast::<f64>();
    let tri = addr_of_mut!(TRI).cast::<i32>();
    let alive = addr_of_mut!(ALIVE).cast::<u8>();
    let free = addr_of_mut!(FREE).cast::<i32>();
    let bad = addr_of_mut!(BAD).cast::<i32>();
    let stk = addr_of_mut!(STK).cast::<i32>();
    let touch = addr_of_mut!(TOUCH).cast::<i32>();
    let out = addr_of_mut!(OUT).cast::<i32>();
    let ect = addr_of_mut!(ECT).cast::<i32>();
    let efu = addr_of_mut!(EFU).cast::<i32>();
    let efv = addr_of_mut!(EFV).cast::<i32>();
    let eused = addr_of_mut!(EUSED).cast::<i32>();
    let em = Em {
        ek: addr_of_mut!(EK).cast::<u64>(),
        es0: addr_of_mut!(ES0).cast::<i32>(),
        es1: addr_of_mut!(ES1).cast::<i32>(),
        ecn: addr_of_mut!(ECN).cast::<i32>(),
    };

    // Reset only the hash slots claimed by the previous run.
    let mut i = 0usize;
    while i < NUSED {
        *em.ek.add(*eused.add(i) as usize) = 0;
        i += 1;
    }
    NUSED = 0;

    // Super-triangle (identical construction to cdt.js).
    let mut min_x = f64::INFINITY;
    let mut min_y = f64::INFINITY;
    let mut max_x = f64::NEG_INFINITY;
    let mut max_y = f64::NEG_INFINITY;
    let mut i = 0usize;
    while i < n {
        let x = *pts.add(i * 2);
        let y = *pts.add(i * 2 + 1);
        if x < min_x { min_x = x; }
        if x > max_x { max_x = x; }
        if y < min_y { min_y = y; }
        if y > max_y { max_y = y; }
        i += 1;
    }
    let mut dx = max_x - min_x;
    if dx == 0.0 { dx = 1.0; }
    let mut dy = max_y - min_y;
    if dy == 0.0 { dy = 1.0; }
    let dm = (if dx > dy { dx } else { dy }) * 20.0;
    let cx = (min_x + max_x) / 2.0;
    let cy = (min_y + max_y) / 2.0;
    *pts.add(n * 2) = cx - dm;
    *pts.add(n * 2 + 1) = cy - dm;
    *pts.add((n + 1) * 2) = cx + dm;
    *pts.add((n + 1) * 2 + 1) = cy - dm;
    *pts.add((n + 2) * 2) = cx;
    *pts.add((n + 2) * 2 + 1) = cy + dm;

    let ni = n as i32;
    let mut ntri = 1usize; // slot high-water mark (== tris.length in cdt.js)
    *tri.add(0) = ni;
    *tri.add(1) = ni + 1;
    *tri.add(2) = ni + 2;
    *alive.add(0) = 1;
    add_te(&em, eslot(&em, ni, ni + 1, true), 0);
    add_te(&em, eslot(&em, ni + 1, ni + 2, true), 0);
    add_te(&em, eslot(&em, ni + 2, ni, true), 0);
    let mut nfree = 0usize;
    let mut last_t: i32 = 0;

    let mut ip: i32 = 0;
    while ip < ni {
        // Walk-to-locate from the previous insertion.
        let mut t = last_t;
        if *alive.add(t as usize) == 0 {
            t = -1;
            let mut j = 0usize;
            while j < ntri {
                if *alive.add(j) != 0 { t = j as i32; break; }
                j += 1;
            }
            if t < 0 { return -1; }
        }
        let g_max = ntri + 64;
        let mut g = 0usize;
        while g < g_max {
            g += 1;
            let a = *tri.add(t as usize * 3);
            let b = *tri.add(t as usize * 3 + 1);
            let c = *tri.add(t as usize * 3 + 2);
            if orient2d(pts, a, b, ip) < 0.0 {
                let nb = nbr(&em, a, b, t);
                if nb < 0 { break; }
                t = nb;
                continue;
            }
            if orient2d(pts, b, c, ip) < 0.0 {
                let nb = nbr(&em, b, c, t);
                if nb < 0 { break; }
                t = nb;
                continue;
            }
            if orient2d(pts, c, a, ip) < 0.0 {
                let nb = nbr(&em, c, a, t);
                if nb < 0 { break; }
                t = nb;
                continue;
            }
            break;
        }
        if *alive.add(t as usize) == 0
            || incircle(pts, *tri.add(t as usize * 3), *tri.add(t as usize * 3 + 1), *tri.add(t as usize * 3 + 2), ip) <= 0.0
        {
            ip += 1;
            continue;
        }
        // Flood the bad-triangle cavity.
        let mut nbad = 0usize;
        let mut nstk = 0usize;
        *bad.add(nbad) = t; nbad += 1;
        *alive.add(t as usize) = 2; // 2 == alive + in badSet
        *stk.add(nstk) = t; nstk += 1;
        while nstk > 0 {
            nstk -= 1;
            let bt = *stk.add(nstk);
            let tb = bt as usize * 3;
            let mut e = 0usize;
            while e < 3 {
                let u = *tri.add(tb + e);
                let v = *tri.add(tb + (e + 1) % 3);
                let nb = nbr(&em, u, v, bt);
                e += 1;
                if nb < 0 || *alive.add(nb as usize) == 2 { continue; }
                let nn = nb as usize * 3;
                if incircle(pts, *tri.add(nn), *tri.add(nn + 1), *tri.add(nn + 2), ip) > 0.0 {
                    *alive.add(nb as usize) = 2;
                    *bad.add(nbad) = nb; nbad += 1;
                    *stk.add(nstk) = nb; nstk += 1;
                }
            }
        }
        // Cavity boundary = edges used by exactly one bad triangle. `touch` keeps
        // the FIRST-SEEN order, mirroring the JS Map insertion order exactly.
        let mut ntouch = 0usize;
        let mut i = 0usize;
        while i < nbad {
            let tb = *bad.add(i) as usize * 3;
            let mut e = 0usize;
            while e < 3 {
                let u = *tri.add(tb + e);
                let v = *tri.add(tb + (e + 1) % 3);
                let s = eslot(&em, u, v, true) as usize;
                let c = *ect.add(s);
                if c == 0 {
                    *efu.add(s) = u;
                    *efv.add(s) = v;
                    *touch.add(ntouch) = s as i32;
                    ntouch += 1;
                }
                *ect.add(s) = c + 1;
                e += 1;
            }
            i += 1;
        }
        let mut i = 0usize;
        while i < nbad {
            let bt = *bad.add(i);
            let tb = bt as usize * 3;
            let mut e = 0usize;
            while e < 3 {
                let s = eslot(&em, *tri.add(tb + e), *tri.add(tb + (e + 1) % 3), true);
                rem_te(&em, s, bt);
                e += 1;
            }
            *alive.add(bt as usize) = 0;
            *free.add(nfree) = bt;
            nfree += 1;
            i += 1;
        }
        let mut i = 0usize;
        while i < ntouch {
            let s = *touch.add(i) as usize;
            let c = *ect.add(s);
            *ect.add(s) = 0; // clear for the next insertion
            i += 1;
            if c != 1 { continue; }
            let nt = if nfree > 0 {
                nfree -= 1;
                *free.add(nfree)
            } else {
                let v = ntri as i32;
                ntri += 1;
                v
            };
            let (u, v) = (*efu.add(s), *efv.add(s));
            // ccw(): normalize to the same winding cdt.js produces.
            let (a, b, c2) = if orient2d(pts, u, v, ip) < 0.0 { (u, ip, v) } else { (u, v, ip) };
            let tb = nt as usize * 3;
            *tri.add(tb) = a;
            *tri.add(tb + 1) = b;
            *tri.add(tb + 2) = c2;
            *alive.add(nt as usize) = 1;
            add_te(&em, eslot(&em, a, b, true), nt);
            add_te(&em, eslot(&em, b, c2, true), nt);
            add_te(&em, eslot(&em, c2, a, true), nt);
            last_t = nt;
        }
        ip += 1;
    }

    // Drop triangles touching the super-triangle.
    let mut nout = 0usize;
    let mut t = 0usize;
    while t < ntri {
        if *alive.add(t) != 0 {
            let a = *tri.add(t * 3);
            let b = *tri.add(t * 3 + 1);
            let c = *tri.add(t * 3 + 2);
            if a < ni && b < ni && c < ni {
                *out.add(nout * 3) = a;
                *out.add(nout * 3 + 1) = b;
                *out.add(nout * 3 + 2) = c;
                nout += 1;
            }
        }
        t += 1;
    }
    nout as i32
}
