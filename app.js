/**
 * WKT S/N Scanner - PWA Core Application Logic
 * Supports: iOS (Safari PWA), Android (Chrome PWA), macOS, Windows
 */

// Global State
let currentTab = 'scanner';
let scannerMode = 'camera'; // 'camera' | 'manual'
let scannerStream = null;
let scannerFacingMode = 'environment';
let isScannerRunning = false;
let scannerAnimationId = null;
let currentZoom = 1;
let isTorchOn = false;
let hasTorch = false;
let barcodeDetector = null;
let zxingReader = null;
let beepAudioCtx = null;
let lastScannedCode = '';
let lastScannedTime = 0;
let lastScannerStartTime = 0;

let currentAssetItem = null;
let batchScanList = [];
let recentScansList = [];

// Default API URL (loaded from localStorage or defaults)
const STORAGE_KEY_API_URL = 'wkt_pwa_api_url';
const DEFAULT_GATEWAY_URL = 'https://script.google.com/a/macros/welkintouch.com/s/AKfycbxyKN6ldirk2cBxst_pbNAdJG8DYAlK7F9wMyzRgCodJ5R9qiSYh5zmwhuMG_vslNSg/exec';
let apiUrl = localStorage.getItem(STORAGE_KEY_API_URL) || DEFAULT_GATEWAY_URL;

// PWA Install prompt event
let deferredInstallPrompt = null;

// =========================================================================
// 🗄️ IndexedDB Configuration & Hoisted Constants
// =========================================================================
const DB_NAME = 'wkt_pwa_db';
const DB_VERSION = 2;
const STORE_ASSETS = 'assets';
const STORE_PDF_CACHE = 'pdf_cache';

// =========================================================================
// 🛡️ System Whitelist Database Gating (ป้องกันสแกนมั่ว - สแกนเฉพาะ S/N ในระบบ)
// =========================================================================
const knownSnSet = new Set();
const knownSnNormalizedMap = new Map();
let isKnownSnCacheLoaded = false;

function addSnToKnownCache(rawSn) {
    if (!rawSn) return;
    const sn = String(rawSn).trim().toUpperCase();
    if (!sn) return;
    knownSnSet.add(sn);

    // Normalize: ตัดช่องว่าง ขีด และสแลช
    const norm = sn.replace(/[\s\-_/]/g, '');
    if (norm) {
        knownSnNormalizedMap.set(norm, sn);
    }

    // Lenovo 1S prefix
    if (sn.startsWith('1S') && sn.length > 3) {
        knownSnNormalizedMap.set(sn.substring(2).replace(/[\s\-_/]/g, ''), sn);
    }

    // Dell Service Tag (7 หลัก) -> Dell Express Service Code (10-11 หลักตัวเลข)
    if (/^[A-Z0-9]{7}$/.test(norm)) {
        try {
            const num = parseInt(norm, 36);
            if (!isNaN(num) && num > 0) {
                knownSnNormalizedMap.set(String(num), sn);
            }
        } catch(e) {}
    }
}

async function initKnownSnMemoryCache() {
    try {
        const db = await openDatabase();
        return new Promise((resolve) => {
            const tx = db.transaction(STORE_ASSETS, 'readonly');
            const store = tx.objectStore(STORE_ASSETS);
            if (store.getAllKeys) {
                const req = store.getAllKeys();
                req.onsuccess = () => {
                    const keys = req.result || [];
                    knownSnSet.clear();
                    knownSnNormalizedMap.clear();
                    for (let i = 0; i < keys.length; i++) {
                        addSnToKnownCache(keys[i]);
                    }
                    isKnownSnCacheLoaded = true;
                    console.log(`🛡️ Whitelist Loaded: ${knownSnSet.size} company S/Ns in memory`);
                    resolve(knownSnSet.size);
                };
                req.onerror = () => resolve(0);
            } else {
                const req = store.openCursor();
                req.onsuccess = (e) => {
                    const cursor = e.target.result;
                    if (cursor) {
                        addSnToKnownCache(cursor.key);
                        cursor.continue();
                    } else {
                        isKnownSnCacheLoaded = true;
                        console.log(`🛡️ Whitelist Loaded: ${knownSnSet.size} company S/Ns in memory`);
                        resolve(knownSnSet.size);
                    }
                };
                req.onerror = () => resolve(0);
            }
        });
    } catch(err) {
        console.warn('initKnownSnMemoryCache warning:', err);
        return 0;
    }
}

/**
 * ตรวจสอบความสอดคล้องกับฐานข้อมูลระบบ (Company Database Whitelist Matching)
 * ถ้า S/N หรือรูปแบบแปลงตรงกับเครื่องที่มีในระบบ จะส่งค่า S/N มาตรฐานในระบบกลับมา
 * ถ้าไม่พบในระบบเลย จะคืนค่า null เพื่อระงับการสแกน (ไม่ส่งเสียง ไม่สั่น ไม่เพิ่มแถวขยะ)
 */
function findSystemMatchingSn(candidate) {
    if (!candidate) return null;
    const clean = String(candidate).trim().toUpperCase();
    if (!clean) return null;

    // หากระบบยังไม่มีข้อมูลในฐานข้อมูลออฟไลน์เลย (เช่น เพิ่งเปิดแอปครั้งแรกสุด)
    if (knownSnSet.size === 0) {
        return clean;
    }

    // 1. ตรวจสอบแบบตรงเป๊ะ
    if (knownSnSet.has(clean)) return clean;
    if (knownSnNormalizedMap.has(clean)) return knownSnNormalizedMap.get(clean);

    // 2. สร้างเซตรูปแบบที่เป็นไปได้
    const pool = new Set();
    pool.add(clean);

    // ตัด Prefix ที่มักติดมากับบาร์โค้ดหรือข้อความ OCR
    const noPrefix = clean.replace(/^(?:\(S\)|S\/N|SN|SERVICE TAG|SERNO|ST|S)[\s:\-_]*/i, '');
    if (noPrefix) pool.add(noPrefix);

    // ตัดเครื่องหมายขีด เว้นวรรค สแลช
    const noDash = clean.replace(/[\s\-_/]/g, '');
    if (noDash) pool.add(noDash);
    if (noPrefix) pool.add(noPrefix.replace(/[\s\-_/]/g, ''));

    // ดึง Substring 7 ตัวอักษร (เช่น Dell Service Tag ที่ติดไอคอนค้นหา หรืออักขระรบกวนหน้า-หลัง เช่น "🔍 BBBHPL3" -> "BBBHPL3")
    if (clean.length > 7) {
        pool.add(clean.substring(clean.length - 7));
        pool.add(clean.substring(0, 7));
        const sevenMatches = clean.match(/[A-Z0-9]{7}/g);
        if (sevenMatches) {
            for (const sm of sevenMatches) pool.add(sm);
        }
    }

    // Lenovo 1S
    if (clean.startsWith('1S') && clean.length > 3) {
        pool.add(clean.substring(2));
        pool.add(clean.substring(2).replace(/[\s\-_/]/g, ''));
    } else {
        pool.add('1S' + clean);
    }

    // Dell Express Service Code (10-11 หลักตัวเลข แปลงเป็น Service Tag 7 ตัวอักษร)
    if (/^[0-9]{10,11}$/.test(noDash)) {
        try {
            const converted = parseInt(noDash, 10).toString(36).toUpperCase();
            if (converted && converted.length === 7) pool.add(converted);
        } catch(e) {}
    }

    // HP Fix: SCD / SCG / SCE -> 5CD / 5CG / 5CE
    for (const item of Array.from(pool)) {
        if (/^S(CD|CG|CE)[A-Z0-9]{7}$/.test(item)) {
            pool.add('5' + item.substring(1));
        }
    }

    // ⚡ OCR Confusion Matrix Disambiguation (แก้ปัญหาตัวอักษรที่อ่านสับสนบนหน้าจอและป้ายสติกเกอร์)
    // B <-> 8, 1 <-> I <-> L, Z <-> 2, O <-> 0, S <-> 5, G <-> 6, D <-> 0
    const confusionPairs = [
        ['8', 'B'], ['B', '8'],
        ['1', 'L'], ['L', '1'], ['I', 'L'], ['L', 'I'], ['1', 'I'], ['I', '1'],
        ['Z', '2'], ['2', 'Z'],
        ['O', '0'], ['0', 'O'],
        ['S', '5'], ['5', 'S'],
        ['G', '6'], ['6', 'G'],
        ['D', '0'], ['0', 'D']
    ];

    const basePoolItems = Array.from(pool);
    for (const item of basePoolItems) {
        if (item.length < 5 || item.length > 20) continue;

        // A) สลับทุกจุดที่พบตัวอักษรนั้นทั้งหมด (เช่น 888 -> BBB)
        for (const [fromC, toC] of confusionPairs) {
            if (item.includes(fromC)) {
                const globalSwapped = item.split(fromC).join(toC);
                pool.add(globalSwapped);
                
                // สลับผสมตัวอื่นๆ เช่น B->8 และ 1->L ร่วมกัน
                if (globalSwapped.includes('1')) pool.add(globalSwapped.split('1').join('L'));
                if (globalSwapped.includes('L')) pool.add(globalSwapped.split('L').join('1'));
                if (globalSwapped.includes('8')) pool.add(globalSwapped.split('8').join('B'));
                if (globalSwapped.includes('B')) pool.add(globalSwapped.split('B').join('8'));
            }
        }

        // B) สลับทีละจุดเฉพาะตำแหน่ง
        for (let i = 0; i < item.length; i++) {
            const ch = item[i];
            for (const [fromC, toC] of confusionPairs) {
                if (ch === fromC) {
                    pool.add(item.substring(0, i) + toC + item.substring(i + 1));
                }
            }
        }
    }

    // ตรวจสอบทุกรูปแบบกับฐานข้อมูลบริษัท (ความเร็ว O(1) ต่อรายการ)
    for (const cand of pool) {
        if (knownSnSet.has(cand)) return cand;
        if (knownSnNormalizedMap.has(cand)) return knownSnNormalizedMap.get(cand);
    }

    // ถ้าไม่พบในระบบฐานข้อมูลเลย ให้คืนค่า null เพื่อหยุดการสแกน
    return null;
}

// =========================================================================
// 🍞 Non-blocking Glassmorphism Toast Notification
// =========================================================================
function showToast(message, type = 'info') {
    let container = document.getElementById('toast-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'toast-container';
        container.className = 'fixed top-12 left-1/2 -translate-x-1/2 z-[100] flex flex-col items-center gap-2 pointer-events-none transition-all duration-300 w-11/12 max-w-sm';
        document.body.appendChild(container);
    }

    const toast = document.createElement('div');
    const colorClasses = type === 'success'
        ? 'bg-emerald-950/90 border-emerald-500/60 text-emerald-200 shadow-emerald-950/50'
        : type === 'warning'
        ? 'bg-amber-950/90 border-amber-500/60 text-amber-200 shadow-amber-950/50'
        : type === 'error'
        ? 'bg-rose-950/90 border-rose-500/60 text-rose-200 shadow-rose-950/50'
        : 'bg-neutral-900/95 border-neutral-700/80 text-white shadow-black/60';

    toast.className = `px-4 py-2.5 rounded-2xl border text-xs font-semibold backdrop-blur-xl shadow-2xl flex items-center gap-2 transform transition-all duration-300 translate-y-[-20px] opacity-0 ${colorClasses}`;
    toast.innerHTML = `<span>${message}</span>`;
    container.appendChild(toast);

    requestAnimationFrame(() => {
        toast.classList.remove('translate-y-[-20px]', 'opacity-0');
        toast.classList.add('translate-y-0', 'opacity-100');
    });

    setTimeout(() => {
        toast.classList.add('translate-y-[-10px]', 'opacity-0');
        setTimeout(() => {
            if (toast.parentNode) toast.parentNode.removeChild(toast);
        }, 300);
    }, 2800);
}

// 🛡️ Camera Unfreeze Guardian: ปลุกกล้องให้เล่นต่อเนื่องเสมอ ไม่ให้หน้าจอค้าง
window.wakeUpCameraIfPaused = function() {
    const video = document.getElementById('scanner-video');
    if (video && isScannerRunning) {
        if (video.paused) {
            console.log('⚡ Waking up paused camera video stream...');
            video.play().catch(() => {});
        }
    }
};

document.addEventListener('visibilitychange', () => {
    if (!document.hidden && currentTab === 'scanner' && scannerMode === 'camera') {
        wakeUpCameraIfPaused();
    }
});

// =========================================================================
// 🚀 Initial Launch & Service Worker
// =========================================================================
document.addEventListener('DOMContentLoaded', async () => {
    // Register Service Worker for PWA
    if ('serviceWorker' in navigator) {
        try {
            await navigator.serviceWorker.register('./sw.js');
            console.log('✅ PWA Service Worker registered successfully');
        } catch (err) {
            console.warn('Service Worker registration warning:', err);
        }
    }

    // Listen for beforeinstallprompt (Android / Desktop Chrome / Edge)
    window.addEventListener('beforeinstallprompt', (e) => {
        e.preventDefault();
        deferredInstallPrompt = e;
        const installBtn = document.getElementById('btn-install-pwa');
        if (installBtn) installBtn.classList.remove('hidden');
    });

    // Load saved settings
    const savedApiInput = document.getElementById('setting-api-url');
    if (savedApiInput && apiUrl) {
        savedApiInput.value = apiUrl;
    }

    // Update connection status badge
    updateApiStatusBadge();

    // Load recent scans from localStorage
    loadRecentScans();

    // Initialize Barcode Reader engines
    await initBarcodeEngines();

    // 🛡️ โหลดรายชื่อ S/N ในระบบทั้งหมดจาก IndexedDB ขึ้น RAM Memory Cache ทันที (Whitelist Gating)
    await initKnownSnMemoryCache();

    // Check PIN Lock state: บังคับให้ใส่รหัส PIN ทุกครั้งที่เปิดเว็บ
    const overlay = document.getElementById('pin-lock-overlay');
    if (overlay) {
        overlay.classList.remove('hidden', 'opacity-0', 'pointer-events-none', '-translate-y-8');
    }
    stopLiveCamera(); // ยังไม่เปิดกล้องจนกว่าจะกรอก PIN ถูกต้อง

    // Sync sheet data in background if API URL is set
    if (apiUrl) {
        syncAllSheetData(false);
    }
});

// Prompt PWA Install
window.promptInstallPwa = function() {
    if (deferredInstallPrompt) {
        deferredInstallPrompt.prompt();
        deferredInstallPrompt.userChoice.then((choiceResult) => {
            if (choiceResult.outcome === 'accepted') {
                console.log('User accepted the PWA install prompt');
            }
            deferredInstallPrompt = null;
            const installBtn = document.getElementById('btn-install-pwa');
            if (installBtn) installBtn.classList.add('hidden');
        });
    }
};

// =========================================================================
// 🔒 PIN Lock Screen Security System (SHA-256 Cryptographic Hash)
// =========================================================================
const STORAGE_KEY_PIN_HASH = 'wkt_pwa_master_pin_hash';
const STORAGE_KEY_AUTH = 'wkt_pwa_auth_token';
const PIN_SALT = 'WKT_SCANNER_SECURE_AUTH_SALT_998822';
// Cryptographic Hash of the master PIN (Plaintext number is NOT stored in code)
const DEFAULT_PIN_HASH = 'bf50f875c8ec485ce32c25c7947c9b64b826f098a64f7b876954c65fe504ad58';
let currentPinInput = '';

async function computePinHash(pin) {
    if (!pin) return '';
    try {
        const msgBuffer = new TextEncoder().encode(PIN_SALT + String(pin));
        const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    } catch(err) {
        let h = 0;
        const str = PIN_SALT + String(pin);
        for (let i = 0; i < str.length; i++) {
            h = ((h << 5) - h) + str.charCodeAt(i);
            h |= 0;
        }
        return 'fb_' + Math.abs(h);
    }
}

function getMasterPinHash() {
    return localStorage.getItem(STORAGE_KEY_PIN_HASH) || DEFAULT_PIN_HASH;
}

let isAppUnlockedState = false; // เริ่มต้นล็อกเสมอทุกรอบที่เปิดเว็บ

function isAppUnlocked() {
    return isAppUnlockedState;
}

function updatePinDots() {
    const dots = document.querySelectorAll('.pin-dot');
    dots.forEach((dot, idx) => {
        if (idx < currentPinInput.length) {
            dot.className = 'w-4 h-4 rounded-full bg-blue-500 border-2 border-blue-400 shadow-sm shadow-blue-500/50 scale-110 transition-all duration-150 pin-dot';
        } else {
            dot.className = 'w-4 h-4 rounded-full border-2 border-neutral-600 transition-all duration-150 pin-dot';
        }
    });
}

window.handlePinKey = function(digit) {
    if (currentPinInput.length >= 4) return;
    currentPinInput += digit;
    updatePinDots();
    
    // Auto-check when 4 digits reached
    if (currentPinInput.length === 4) {
        setTimeout(verifyEnteredPin, 100);
    }
};

window.handlePinDelete = function() {
    if (currentPinInput.length > 0) {
        currentPinInput = currentPinInput.slice(0, -1);
        updatePinDots();
    }
};

async function verifyEnteredPin() {
    const masterHash = getMasterPinHash();
    const enteredHash = await computePinHash(currentPinInput);
    const errorMsg = document.getElementById('pin-error-msg');
    const container = document.getElementById('pin-dots-container');
    
    if (enteredHash === masterHash) {
        // Success: ปลดล็อกสำหรับรอบนี้
        isAppUnlockedState = true;
        const dots = document.querySelectorAll('.pin-dot');
        dots.forEach(d => {
            d.className = 'w-4 h-4 rounded-full bg-emerald-500 border-2 border-emerald-400 shadow-md shadow-emerald-500/60 scale-125 transition-all duration-200 pin-dot';
        });
        
        setTimeout(() => {
            const overlay = document.getElementById('pin-lock-overlay');
            if (overlay) {
                overlay.classList.add('opacity-0', 'pointer-events-none', '-translate-y-8');
                setTimeout(() => {
                    overlay.classList.add('hidden');
                }, 300);
            }
            // Start Camera
            if (currentTab === 'scanner' && scannerMode === 'camera' && !scannerStream) {
                startLiveCamera();
            }
        }, 200);
    } else {
        // Failed
        if (errorMsg) errorMsg.classList.remove('opacity-0');
        if (container) {
            container.classList.add('shake-pin');
            const dots = document.querySelectorAll('.pin-dot');
            dots.forEach(d => {
                d.className = 'w-4 h-4 rounded-full bg-rose-500 border-2 border-rose-400 shadow-sm shadow-rose-500/50 pin-dot';
            });
            setTimeout(() => {
                container.classList.remove('shake-pin');
                currentPinInput = '';
                updatePinDots();
                setTimeout(() => {
                    if (errorMsg) errorMsg.classList.add('opacity-0');
                }, 1500);
            }, 450);
        }
    }
}

window.lockAppNow = function() {
    isAppUnlockedState = false;
    stopLiveCamera();
    currentPinInput = '';
    updatePinDots();
    const overlay = document.getElementById('pin-lock-overlay');
    if (overlay) {
        overlay.classList.remove('hidden', 'opacity-0', 'pointer-events-none', '-translate-y-8');
    }
    switchMainTab('scanner');
};

// ล็อกหน้าจออัตโนมัติหากสลับแอพ หรือพับหน้าจอไปเกิน 30 วินาที
let lastAppHiddenTimestamp = 0;
document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        lastAppHiddenTimestamp = Date.now();
    } else {
        if (lastAppHiddenTimestamp && (Date.now() - lastAppHiddenTimestamp > 30000)) {
            lockAppNow();
        }
    }
});

let secretAdminTapCount = 0;
let secretAdminTapTimer = null;
window.handleSecretAdminPinTrigger = function() {
    secretAdminTapCount++;
    if (secretAdminTapTimer) clearTimeout(secretAdminTapTimer);
    secretAdminTapTimer = setTimeout(() => {
        secretAdminTapCount = 0;
    }, 2500);

    // แตะติดกัน 5 ครั้งภายใน 2.5 วินาที เพื่อเปิดหน้าต่างเปลี่ยนรหัส PIN (สำหรับแอดมินคนเดียว)
    if (secretAdminTapCount >= 5) {
        secretAdminTapCount = 0;
        window.changePinCode();
    }
};

window.changePinCode = async function() {
    const masterHash = getMasterPinHash();
    const oldInput = prompt('กรุณากรอกรหัส PIN เดิมปัจจุบัน:');
    if (oldInput === null) return;
    const oldHash = await computePinHash(oldInput);
    if (oldHash !== masterHash) {
        alert('❌ รหัส PIN เดิมไม่ถูกต้อง');
        return;
    }
    const newPin = prompt('กรุณากรอกรหัส PIN ใหม่ 4 หลัก (ตัวเลขเท่านั้น):');
    if (newPin === null) return;
    if (!/^\d{4}$/.test(newPin)) {
        alert('❌ กรุณาระบุรหัส PIN เป็นตัวเลข 4 หลักเท่านั้น');
        return;
    }
    const confirmPin = prompt('กรุณายืนยันรหัส PIN ใหม่อีกครั้ง:');
    if (confirmPin !== newPin) {
        alert('❌ รหัสยืนยันไม่ตรงกัน');
        return;
    }
    const newHash = await computePinHash(newPin);
    localStorage.setItem(STORAGE_KEY_PIN_HASH, newHash);
    alert('✅ เปลี่ยนรหัสผ่าน PIN สำเร็จเรียบร้อย!');
};

// Physical keyboard support for laptop / PC
document.addEventListener('keydown', (e) => {
    const overlay = document.getElementById('pin-lock-overlay');
    if (!overlay || overlay.classList.contains('hidden')) return;
    if (e.key >= '0' && e.key <= '9') {
        handlePinKey(e.key);
    } else if (e.key === 'Backspace') {
        handlePinDelete();
    }
});

// =========================================================================
// 📷 Live Camera Management (Direct Native getUserMedia - 100% on iOS PWA)
// =========================================================================
async function startLiveCamera() {
    if (!isAppUnlocked()) return;
    stopLiveCamera();

    const video = document.getElementById('scanner-video');
    const overlay = document.getElementById('scanner-status-overlay');

    if (overlay) {
        overlay.classList.remove('hidden');
        overlay.innerHTML = `
            <div class="flex flex-col items-center gap-2">
                <span class="text-3xl animate-spin">⏳</span>
                <span class="text-sm font-bold text-white">กำลังเปิดกล้อง...</span>
                <span class="text-xs text-neutral-400">กรุณากด "อนุญาต (Allow)" หากมีข้อความขอใช้กล้อง</span>
            </div>
        `;
    }

    const constraintsCandidates = [
        {
            audio: false,
            video: {
                facingMode: { ideal: scannerFacingMode },
                width: { ideal: 1920, min: 1280 },
                height: { ideal: 1080, min: 720 },
                focusMode: { ideal: 'continuous' }
            }
        },
        {
            audio: false,
            video: {
                facingMode: { ideal: scannerFacingMode },
                width: { ideal: 1280 },
                height: { ideal: 720 }
            }
        },
        {
            audio: false,
            video: { facingMode: scannerFacingMode }
        },
        {
            audio: false,
            video: true
        }
    ];

    let stream = null;
    let cameraError = null;

    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
        for (let i = 0; i < constraintsCandidates.length; i++) {
            try {
                stream = await navigator.mediaDevices.getUserMedia(constraintsCandidates[i]);
                if (stream) break;
            } catch (err) {
                cameraError = err;
            }
        }
    } else {
        cameraError = new Error('navigator.mediaDevices.getUserMedia not available');
    }

    if (!stream) {
        renderCameraFallbackUI(cameraError);
        return;
    }

    scannerStream = stream;

    if (video) {
        video.srcObject = stream;
        video.setAttribute('playsinline', 'true');
        video.setAttribute('webkit-playsinline', 'true');
        video.muted = true;
        try {
            await video.play();
        } catch (e) {
            console.warn('Video play warning:', e);
        }

        // 🛡️ Safari Watchdog: ป้องกัน iOS พักวิดีโอตอนสลับแอปหรือกดปุ่ม
        video.onpause = () => {
            if (isScannerRunning && currentTab === 'scanner') {
                setTimeout(() => {
                    if (video && video.paused && isScannerRunning) {
                        video.play().catch(() => {});
                    }
                }, 100);
            }
        };
    }

    if (overlay) overlay.classList.add('hidden');

    lastScannerStartTime = Date.now();
    inspectCameraCapabilities();
    startDetectionLoop();

    // Default 1X zoom
    setTimeout(() => {
        setZoomLevel(1);
    }, 350);
}

function stopLiveCamera() {
    isScannerRunning = false;
    if (scannerAnimationId) {
        cancelAnimationFrame(scannerAnimationId);
        scannerAnimationId = null;
    }

    if (scannerStream) {
        try {
            scannerStream.getTracks().forEach((track) => {
                try { track.stop(); } catch(e) {}
            });
        } catch(e) {}
        scannerStream = null;
    }

    const video = document.getElementById('scanner-video');
    if (video) video.srcObject = null;

    isTorchOn = false;
    updateTorchBtnUI();
}

function renderCameraFallbackUI(err) {
    const overlay = document.getElementById('scanner-status-overlay');
    if (!overlay) return;

    overlay.classList.remove('hidden');
    overlay.innerHTML = `
        <div class="flex flex-col items-center gap-3 max-w-xs">
            <div class="w-12 h-12 rounded-full bg-neutral-800 border border-neutral-700 flex items-center justify-center text-xl">
                📷
            </div>
            <div class="text-sm font-bold text-white">ต้องการเข้าถึงกล้องถ่ายภาพ</div>
            <div class="text-xs text-neutral-400 leading-relaxed">
                เพื่อสแกนหมายเลขประจำเครื่อง หรือคุณสามารถถ่ายภาพและป้อนด้วยตนเองได้ทันที
            </div>

            <button type="button" onclick="triggerNativeCapture()" class="w-full py-2.5 px-4 bg-blue-600 hover:bg-blue-500 active:scale-95 text-white rounded-xl text-xs font-bold shadow-lg flex items-center justify-center gap-2 cursor-pointer transition-all">
                <span>📸</span> <span>ถ่ายภาพเพื่อสแกน S/N</span>
            </button>

            <button type="button" onclick="switchScannerMode('manual')" class="w-full py-2 px-4 bg-neutral-800 hover:bg-neutral-700 text-neutral-200 rounded-xl text-xs font-semibold flex items-center justify-center gap-2 cursor-pointer transition-colors border border-neutral-700">
                <span>⌨️</span> <span>ป้อนหมายเลขประจำเครื่องด้วยตนเอง</span>
            </button>

            <button type="button" onclick="startLiveCamera()" class="mt-1 text-xs text-blue-400 hover:underline">
                🔄 ลองเปิดกล้องใหม่อีกครั้ง
            </button>
        </div>
    `;
}

// Camera Capabilities (Zoom, Torch)
function inspectCameraCapabilities() {
    hasTorch = false;
    const track = scannerStream ? scannerStream.getVideoTracks()[0] : null;
    if (track && typeof track.getCapabilities === 'function') {
        try {
            const caps = track.getCapabilities();
            if (caps.torch) hasTorch = true;
        } catch(e) {}
    }

    const torchBtn = document.getElementById('btn-torch');
    if (torchBtn) {
        if (hasTorch) {
            torchBtn.classList.remove('opacity-40', 'cursor-not-allowed');
            torchBtn.removeAttribute('disabled');
        } else {
            torchBtn.classList.add('opacity-40');
        }
    }
}

async function toggleTorch() {
    const track = scannerStream ? scannerStream.getVideoTracks()[0] : null;
    if (!track) return;

    try {
        isTorchOn = !isTorchOn;
        await track.applyConstraints({ advanced: [{ torch: isTorchOn }] });
        updateTorchBtnUI();
    } catch(e) {
        isTorchOn = false;
        updateTorchBtnUI();
    }
}

function updateTorchBtnUI() {
    const torchBtn = document.getElementById('btn-torch');
    const torchIcon = document.getElementById('torch-icon');
    if (!torchBtn) return;

    if (isTorchOn) {
        torchBtn.classList.add('bg-amber-500', 'border-amber-300');
        torchBtn.classList.remove('bg-black/60');
        if (torchIcon) torchIcon.textContent = '💡';
    } else {
        torchBtn.classList.remove('bg-amber-500', 'border-amber-300');
        torchBtn.classList.add('bg-black/60');
        if (torchIcon) torchIcon.textContent = '🔦';
    }
}

async function setZoomLevel(level) {
    currentZoom = level;
    updateZoomBtnUI();

    const track = scannerStream ? scannerStream.getVideoTracks()[0] : null;
    let hwZoomSuccess = false;

    if (track && typeof track.applyConstraints === 'function') {
        try {
            await track.applyConstraints({ advanced: [{ zoom: level }] });
            hwZoomSuccess = true;
        } catch(e) {}
    }

    const video = document.getElementById('scanner-video');
    if (video) {
        if (!hwZoomSuccess && level > 1) {
            video.style.transform = `scale(${level})`;
            video.style.transformOrigin = 'center center';
        } else {
            video.style.transform = 'scale(1)';
        }
    }
}

function updateZoomBtnUI() {
    const b1 = document.getElementById('btn-zoom-1');
    const b2 = document.getElementById('btn-zoom-2');
    const b3 = document.getElementById('btn-zoom-3');

    const setActive = (btn, active) => {
        if (!btn) return;
        btn.className = active
            ? "w-6 h-6 rounded-full text-[11px] font-bold bg-emerald-500 text-white transition-all shadow-sm"
            : "w-6 h-6 rounded-full text-[11px] font-bold bg-white/20 text-white transition-all hover:bg-white/30";
    };

    setActive(b1, currentZoom === 1);
    setActive(b2, currentZoom === 2);
    setActive(b3, currentZoom === 3);
}

async function switchCameraFacing() {
    scannerFacingMode = (scannerFacingMode === 'environment') ? 'user' : 'environment';
    await startLiveCamera();
}

// =========================================================================
// ⚡ Barcode Detection Engine (Hardware Native GPU + ZXing Quiet-Zone Fallback)
// =========================================================================
// ⚡ Barcode & Live Text OCR Dual Detection Engine
// =========================================================================
let ocrWorker = null;
let isOcrBusy = false;
let lastOcrTime = 0;
let ocrCanvas = null;
let ocrCtx = null;

async function initBarcodeEngines() {
    barcodeDetector = null;
    if (typeof window !== 'undefined' && 'BarcodeDetector' in window) {
        try {
            const supported = await BarcodeDetector.getSupportedFormats();
            const desired = ['code_128', 'code_39', 'code_93', 'ean_13', 'qr_code', 'data_matrix'];
            const active = desired.filter(f => supported.includes(f));
            if (active.length > 0) {
                barcodeDetector = new BarcodeDetector({ formats: active });
                console.log('⚡ Native BarcodeDetector initialized:', active);
            }
        } catch(e) {}
    }

    if (typeof ZXing !== 'undefined' && ZXing.BrowserMultiFormatReader) {
        try {
            const hints = new Map();
            if (typeof ZXing.DecodeHintType !== 'undefined') {
                hints.set(ZXing.DecodeHintType.TRY_HARDER, true);
                hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, [
                    ZXing.BarcodeFormat.DATA_MATRIX,
                    ZXing.BarcodeFormat.QR_CODE,
                    ZXing.BarcodeFormat.CODE_128,
                    ZXing.BarcodeFormat.CODE_39,
                    ZXing.BarcodeFormat.CODE_93,
                    ZXing.BarcodeFormat.EAN_13
                ]);
            }
            zxingReader = new ZXing.BrowserMultiFormatReader(hints);
            console.log('🏎️ ZXing fallback reader ready with Data Matrix & Try Harder');
        } catch(e) {
            try { zxingReader = new ZXing.BrowserMultiFormatReader(); } catch(e2) {}
        }
    }

    // Initialize Tesseract OCR Engine for reading printed text / screen text
    initOcrEngine();
}

async function initOcrEngine() {
    if (typeof Tesseract === 'undefined' || ocrWorker) return;
    try {
        console.log('⏳ Initializing Live Text OCR worker...');
        ocrWorker = await Tesseract.createWorker('eng');
        await ocrWorker.setParameters({
            tessedit_char_whitelist: '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz: -/.',
            tessedit_pageseg_mode: '6' // Uniform block of text: ข้ามการวิเคราะห์เค้าโครงเอกสาร ทำให้เร็วขึ้น 3-5 เท่า!
        });
        console.log('✅ Apple-Style Live Text OCR Worker ready!');
    } catch(err) {
        console.warn('OCR worker init error:', err);
    }
}

function startDetectionLoop() {
    isScannerRunning = true;
    runDetectionFrame();
}

let lastZxingFrameTime = 0;
let reticleCropCanvas = null;
let reticleCropCtx = null;

/**
 * 📐 Dynamic Reticle Crop Engine: คำนวณพิกัดการตัดภาพจากตำแหน่งกรอบเล็งบนหน้าจอจริง 100%
 * รองรับทั้งจอแนวตั้ง แนวนอน object-cover และ CSS Zoom Scale (1X, 2X, 3X)
 * มั่นใจได้ว่าทุกกลไกสแกนเนอร์ (BarcodeDetector, ZXing, OCR) จะเห็นและประมวลผล "เฉพาะพื้นที่ในกรอบเล็งกลางจอ" เท่านั้น
 */
function getReticleCropRect(video, reticle) {
    if (!video || !video.videoWidth || !video.videoHeight) return null;
    const vw = video.videoWidth;
    const vh = video.videoHeight;

    if (!reticle) {
        const fallbackW = Math.floor(vw * 0.7);
        const fallbackH = Math.floor(vh * 0.2);
        return {
            x: Math.max(0, Math.floor((vw - fallbackW) / 2)),
            y: Math.max(0, Math.floor((vh - fallbackH) / 2)),
            w: fallbackW,
            h: fallbackH
        };
    }

    const vRect = video.getBoundingClientRect();
    const rRect = reticle.getBoundingClientRect();

    if (!vRect.width || !vRect.height || !rRect.width || !rRect.height) {
        const fallbackW = Math.floor(vw * 0.7);
        const fallbackH = Math.floor(vh * 0.2);
        return {
            x: Math.max(0, Math.floor((vw - fallbackW) / 2)),
            y: Math.max(0, Math.floor((vh - fallbackH) / 2)),
            w: fallbackW,
            h: fallbackH
        };
    }

    // คำนวณ CSS Zoom Scale (จากการขยายผ่าน CSS transform เช่น scale(2))
    let cssZoom = 1;
    if (video.style.transform) {
        const match = video.style.transform.match(/scale\(([\d.]+)\)/);
        if (match && match[1]) {
            cssZoom = parseFloat(match[1]) || 1;
        }
    }

    // ขนาด element ก่อนขยายด้วย CSS transform
    const elemW = vRect.width / cssZoom;
    const elemH = vRect.height / cssZoom;

    // คำนวณอัตราส่วนการขยายแบบ object-cover
    const coverScale = Math.max(elemW / vw, elemH / vh);
    const totalScale = coverScale * cssZoom;

    // ขนาดกรอบเล็งในสเกลพิกเซลจริงของ Video Sensor
    const cropW = Math.round(rRect.width / totalScale);
    const cropH = Math.round(rRect.height / totalScale);

    // ตำแหน่งจุดกึ่งกลางของกรอบเล็งเทียบกับจุดกึ่งกลางของ Video
    const rCenterX = rRect.left + rRect.width / 2;
    const rCenterY = rRect.top + rRect.height / 2;
    const vCenterX = vRect.left + vRect.width / 2;
    const vCenterY = vRect.top + vRect.height / 2;

    const diffX = (rCenterX - vCenterX) / totalScale;
    const diffY = (rCenterY - vCenterY) / totalScale;

    // เผื่อขอบ 10% ให้พื้นที่กรอบเล็งกว้างขึ้นเล็กน้อย เล็งง่ายขึ้น ตัวหนังสือชิดขอบก็ยังอ่านได้
    const padX = Math.round(cropW * 0.10);
    const padY = Math.round(cropH * 0.10);

    let cropX = Math.round((vw / 2) + diffX - (cropW / 2)) - padX;
    let cropY = Math.round((vh / 2) + diffY - (cropH / 2)) - padY;

    // ตรวจสอบขอบเขตให้อยู่ในเนื้อวิดีโอเสมอ
    cropX = Math.max(0, Math.min(cropX, vw - 10));
    cropY = Math.max(0, Math.min(cropY, vh - 10));
    const finalW = Math.max(10, Math.min(cropW + (padX * 2), vw - cropX));
    const finalH = Math.max(10, Math.min(cropH + (padY * 2), vh - cropY));

    return { x: cropX, y: cropY, w: finalW, h: finalH };
}

let currentReticleShape = 'sticker'; // 'sticker' (48% height) | 'barcode' (28% height)

window.toggleReticleShape = function() {
    const reticle = document.getElementById('scanner-reticle');
    const icon = document.getElementById('reticle-shape-icon');
    const text = document.getElementById('reticle-shape-text');
    if (!reticle) return;

    if (currentReticleShape === 'sticker') {
        currentReticleShape = 'barcode';
        reticle.classList.remove('h-[48%]', 'h-[50%]');
        reticle.classList.add('h-[28%]');
        if (icon) icon.textContent = '📏';
        if (text) text.textContent = 'แถบบาร์โค้ด';
    } else {
        currentReticleShape = 'sticker';
        reticle.classList.remove('h-[28%]');
        reticle.classList.add('h-[48%]');
        if (icon) icon.textContent = '🔲';
        if (text) text.textContent = 'สติกเกอร์';
    }
};

function updateReticleCropCanvas(video, reticle) {
    const crop = getReticleCropRect(video, reticle);
    if (!crop) return null;

    if (!reticleCropCanvas) {
        reticleCropCanvas = document.createElement('canvas');
        reticleCropCtx = reticleCropCanvas.getContext('2d', { willReadFrequently: true });
    }

    // กำหนดความกว้างให้อยู่ในช่วง 480 - 560px เพื่อความเร็วสูงสุด
    // เป็นขนาดที่เหมาะที่สุดสำหรับ Tesseract LSTM Neural Network (ตัวหนังสือสูง ~30-36px)
    // ลดภาระประมวลผล WASM ลง ~45% ช่วยให้ยิงติดในเสี้ยววินาที
    const targetW = Math.min(Math.max(crop.w, 480), 560);
    const targetH = Math.max(50, Math.round((crop.h * targetW) / crop.w));

    if (reticleCropCanvas.width !== targetW || reticleCropCanvas.height !== targetH) {
        reticleCropCanvas.width = targetW;
        reticleCropCanvas.height = targetH;
    }

    // ⚡ เพิ่มคอนทราสต์และ Grayscale เพื่อกำจัดลาย Moiré / แสงสะท้อนจากหน้าจอคอมพิวเตอร์ ทำให้อักษรคมชัดทันที
    reticleCropCtx.imageSmoothingEnabled = true;
    reticleCropCtx.imageSmoothingQuality = 'high';
    reticleCropCtx.filter = 'grayscale(1) contrast(1.35) brightness(1.05)';
    reticleCropCtx.drawImage(video, crop.x, crop.y, crop.w, crop.h, 0, 0, targetW, targetH);
    reticleCropCtx.filter = 'none';
    return { crop, canvas: reticleCropCanvas, ctx: reticleCropCtx };
}

async function runDetectionFrame() {
    if (!isScannerRunning) return;

    const video = document.getElementById('scanner-video');
    const reticle = document.getElementById('scanner-reticle');

    // 🛡️ Auto-Healing: หากวิดีโอถูก Safari หรือระบบพัก ให้ปลุกกล้องอัตโนมัติ
    if (video && isScannerRunning && video.paused) {
        try { video.play(); } catch(e) {}
    }

    if (video && video.readyState >= video.HAVE_CURRENT_DATA && !video.paused) {
        try {
            let barcodeFound = false;

            // 🎯 ตัดภาพเฉพาะพื้นที่ในกรอบเล็งกลางจอ (Center Box Only)
            const cropInfo = updateReticleCropCanvas(video, reticle);

            if (cropInfo) {
                const { crop, canvas: cropCanvas } = cropInfo;

                // 1. Native GPU BarcodeDetector (< 25ms) ตรวจจับบาร์โค้ดฮาร์ดแวร์โดยตรง
                if (barcodeDetector) {
                    try {
                        let barcodes = [];
                        try {
                            // สแกนตรงจาก Canvas ที่ตัดเฉพาะกรอบเล็ง
                            barcodes = await barcodeDetector.detect(cropCanvas);
                        } catch(cvErr) {
                            // หากเบราว์เซอร์ไม่รองรับ Canvas ใน BarcodeDetector ให้สแกนจาก Video แต่กรองเฉพาะที่อยู่ในกรอบเล็ง
                            const allBarcodes = await barcodeDetector.detect(video);
                            if (allBarcodes && allBarcodes.length > 0) {
                                barcodes = allBarcodes.filter(b => {
                                    if (!b.boundingBox) return true;
                                    const bb = b.boundingBox;
                                    const cx = bb.x + bb.width / 2;
                                    const cy = bb.y + bb.height / 2;
                                    return (cx >= crop.x && cx <= crop.x + crop.w &&
                                            cy >= crop.y && cy <= crop.y + crop.h);
                                });
                            }
                        }

                        if (barcodes && barcodes.length > 0) {
                            for (let i = 0; i < barcodes.length; i++) {
                                if (barcodes[i] && barcodes[i].rawValue) {
                                    if (handleDetectedBarcode(barcodes[i].rawValue)) {
                                        barcodeFound = true;
                                        break;
                                    }
                                }
                            }
                        }
                    } catch(detErr) {}
                }

                // 2. Fallback: ZXing เฉพาะกรอบกลางจอ
                if (!barcodeFound && zxingReader) {
                    const now = Date.now();
                    if (now - lastZxingFrameTime > 60) {
                        lastZxingFrameTime = now;
                        try {
                            const result = zxingReader.decodeFromCanvas(cropCanvas);
                            if (result && result.text) {
                                if (handleDetectedBarcode(result.text)) {
                                    barcodeFound = true;
                                }
                            }
                        } catch(e) {}
                    }
                }

                // 3. 🤖 Apple-Style Live Text OCR (ยิงเร็วติดไวระดับ ~100ms)
                if (!barcodeFound && ocrWorker && !isOcrBusy) {
                    const now = Date.now();
                    if ((now - lastScannerStartTime > 150) && (now - lastOcrTime > 100)) {
                        lastOcrTime = now;
                        runOcrOnVideoReticle(cropCanvas);
                    }
                }
            }
        } catch(err) {}
    }

    if (isScannerRunning) {
        scannerAnimationId = requestAnimationFrame(runDetectionFrame);
    }
}

const OCR_BLACKLIST = [
    // Power & Electrical & Voltage
    'ADAPTER', 'INPUT', 'OUTPUT', 'WATT', '200W', '65W', '45W', '90W', '135W', '150W',
    '100-240V', '19.5V', '50-60HZ', 'SAFETY', 'REGULATORY', 'COMPLIANCE', 'LEVEL', 'EFFICIENCY', 'DIRECT', 'CURRENT', 'AC', 'DC',
    '3.34A', '2.31A', '4.62A', 'DAYA',

    // Dell Regulatory Model & Types (P169G, P169G003, etc.)
    'P169G', 'P169G003', 'TYPE NO', 'TYPENO', 'REGULATORY MODEL', 'RMN', 'RATING',
    'MFG YR', 'MFGYR', 'MFG', 'CREECHURCH', 'LONDON', 'EC3A', 'UK ONLY', 'ONE CREECHURCH',
    
    // Model & Hardware Brand Names (MUST NEVER BE CONFUSED WITH S/N)
    'PROBOOK', 'PR0B00K', 'ELITEBOOK', 'ELITEBK', 'LATITUDE', 'OPTIPLEX', 'PRECISION', 
    'INSPIRON', 'VOSTRO', 'THINKPAD', 'THINKCENTRE', 'IDEAPAD', 'YOGA', 'LEGION',
    'EXPERTBOOK', 'ZENBOOK', 'VIVOBOOK', 'CHROMEBOOK', 'SURFACE', 'PAVILION', 'ENVY', 'OMEN', 'SPECTRE',
    'MACBOOK', 'MACBOOKAIR', 'MACBOOKPRO', 'DESKTOP', 'LAPTOP', 'NOTEBOOK', 'MONITOR', 'DISPLAY',
    'SERIES', 'MODEL', 'COMPUTER', 'WINDOWS', 'INTEL', 'RADEON', 'GEFORCE', 'NVIDIA', 'OFFICE',
    'KEYBOARD', 'MOUSE', 'BATTERY', 'CHARGER', 'ASUS', 'ACER', 'DELL', 'LENOVO', 'APPLE', 'HP',

    // Sticker Contact / Label text (like seen on rental stickers)
    'COMMEDIA', 'COMMEDIAPLUS', 'SUPPORT', 'LINEID', 'PHONE', 'MOBILE', 'EMAIL', 'GMAIL',
    'TEL', 'WWW', 'HTTP', 'HTTPS', 'EILERT',
    
    // Certifications & Regulatory
    'MADE IN', 'CAN ICES', 'REV', 'CHIP', 'MEMORY', 'STARTUP', 'DISK',
    'MACINTOSH', 'MACOS', 'GOLDEN', 'GATE', 'VERSION', 'ABOUT', 'SYSTEM',
    'HSTNN', 'TPN', '15-F20087', 'PA-1200', 'TPN-CA', 'PA-1', 'MSIP', 'R41', 'ICES-3', 'NMB-3',

    // Product ID / Model Number / Warranty text (Laser etched on HP / Lenovo / Dell back cases)
    'PRODID', 'PROD ID', 'PRODUCT ID', 'PRODUCTID', 'WARRANTY', '1Y1Y0Y', '3Y3Y0Y', '3Y3Y3Y', '#AKL', 'AKL'
];

let candidateOcrSn = null;
let candidateOcrCount = 0;
let ocrAutoAdvanceTimer = null;
let ocrCountdownInterval = null;

async function runOcrOnVideoReticle(cropCanvas) {
    if (!ocrWorker || isOcrBusy || !cropCanvas) return;
    isOcrBusy = true;

    try {
        const result = await ocrWorker.recognize(cropCanvas);
        if (result && result.data && result.data.text) {
            const detected = extractSerialFromOcrText(result.data.text);
            if (detected && detected.sn) {
                // 🛡️ System Whitelist Gating: ต้องตรงกับ S/N ในระบบเท่านั้น จึงจะถือว่าพบ S/N
                const matchedSn = findSystemMatchingSn(detected.sn);
                if (!matchedSn) {
                    const pill = document.getElementById('reticle-ocr-pill');
                    if (pill) pill.classList.add('opacity-0');
                    return;
                }

                const sn = matchedSn;
                const isLabeled = detected.isLabeled;

                // Update live reticle floating pill (Apple Style)
                const pill = document.getElementById('reticle-ocr-pill');
                const pillText = document.getElementById('reticle-ocr-text');
                if (pill && pillText) {
                    pillText.textContent = `🎯 ${sn}`;
                    pill.classList.remove('opacity-0');
                }

                // Consecutive frame stability check (Labeled requires 1 frame, raw pattern requires 2 frames)
                if (sn === candidateOcrSn) {
                    candidateOcrCount++;
                } else {
                    candidateOcrSn = sn;
                    candidateOcrCount = 1;
                }

                // 🛡️ หากตรงกับ S/N ในระบบ (System Whitelist) หรือมีป้ายกำกับชัดเจน หรือ Continuous mode หรือจับคู่ได้ 2 เฟรมติด -> ยิงทันที 1 เฟรม!
                const isWhitelisted = !!findSystemMatchingSn(sn);
                if (isWhitelisted || isLabeled || cameraScanMode === 'continuous' || candidateOcrCount >= 2) {
                    candidateOcrSn = null;
                    candidateOcrCount = 0;
                    console.log('🎉 Confirmed OCR Serial Number in reticle:', sn);
                    handleDetectedOcrSerial(sn);
                }
            } else {
                // Clear pill if nothing detected in reticle
                const pill = document.getElementById('reticle-ocr-pill');
                if (pill && candidateOcrCount === 0) {
                    pill.classList.add('opacity-0');
                }
            }
        }
    } catch(ocrErr) {
    } finally {
        isOcrBusy = false;
    }
}

/**
 * แก้ไขตัวอักษรที่ OCR มักอ่านผิดใน Serial Number
 * เช่น HP: ตัวแรก 'S' -> '5' (SCD -> 5CD), เลข 0 vs O, 1 vs I
 */
function disambiguateSerial(s) {
    if (!s) return s;
    let res = s.toUpperCase().trim();

    // 1. HP Fix: S/N ความยาว 10 ตัว เริ่มต้นด้วย SCD, SCG, SCE ให้แปลงตัวแรกเป็น '5'
    if (/^S(CD|CG|CE)[A-Z0-9]{7}$/.test(res)) {
        res = '5' + res.substring(1);
    }

    // 2. HP ตำแหน่งที่ 3-5 (สัปดาห์และปีผลิต) ต้องเป็นตัวเลข
    // เช่น 5CD 238 M2D5 -> 238 ต้องเป็นตัวเลขเสมอ
    // จำกัดเฉพาะ S/N ที่มีคำขึ้นต้นของ HP เท่านั้น (5CD, 5CG, 5CE, CND, 4CE, 8CG, 2CE, CZC, CNU, 3CE, SCD, SCG, SCE)
    if (/^(?:(?:5|S)(?:CD|CG|CE)|CND|4CE|8CG|2CE|CZC|CNU|3CE)[A-Z0-9]{7}$/.test(res)) {
        let chars = res.split('');
        for (let i = 3; i <= 5; i++) {
            if (chars[i] === 'O' || chars[i] === 'D' || chars[i] === 'Q') chars[i] = '0';
            if (chars[i] === 'I' || chars[i] === 'L' || chars[i] === 'T' || chars[i] === '|' || chars[i] === '!') chars[i] = '1';
            if (chars[i] === 'S') chars[i] = '5';
            if (chars[i] === 'B') chars[i] = '8';
        }
        res = chars.join('');
    }

    // 3. Apple Serial Number: Apple ไม่ใช้ตัวอักษร 'O' (ใช้เลข '0' เสมอ)
    // ทำเฉพาะเมื่อมีตัวเลขอื่นอยู่แล้ว และไม่ใช่ข้อความภาษาอังกฤษล้วน
    if ((res.length === 10 || res.length === 12) && /[0-9]/.test(res) && !/^[A-Z]+$/.test(res) && !/^[0-9]+$/.test(res)) {
        res = res.replace(/O/g, '0');
    }

    return res;
}

/**
 * ตรวจสอบความถูกต้องของ Serial Number
 */
function isValidSerialNumber(token) {
    if (!token || token.length < 5 || token.length > 25) return false;
    const upper = token.toUpperCase();
    if (OCR_BLACKLIST.some(b => upper.includes(b))) return false;
    if (upper.endsWith('BOOK') || upper.endsWith('B00K')) return false;
    if (/^[0-9]+W$/.test(upper)) return false;
    if (/^(?:HSTNN|TPN|ADP|PA1|WKT|CAN|MSIP|R41)/.test(upper)) return false;

    // Filter out Dell Regulatory Model formats (e.g. P169G, P169G003, P149G, P119G)
    if (/^P\d{3}[A-Z](\d{3})?$/i.test(upper)) return false;

    // Filter out UK Postcodes (e.g. EC3A5AF, EC3A, etc.)
    if (/^[A-Z]{1,2}\d[A-Z\d]?\d[A-Z]{2}$/i.test(upper)) return false;

    // Filter out MFG Year / Date patterns (e.g. MFGYR2024, YR2024, 2024)
    if (/^(?:MFG|YR|DOM)?202[0-9]$/i.test(upper)) return false;
    if (/^(?:MFG|YR|DOM)/i.test(upper)) return false;

    // Filter out Voltage / Current specs (e.g. 195V334A, 195V, 334A)
    if (/\d+V\d+A/i.test(upper) || /^\d+(\.\d+)?(?:V|A)$/i.test(upper)) return false;

    return true;
}

/**
 * ดึงเลข Serial Number สไตล์ Apple Support (คัดกรองเฉพาะ S/N แท้ ไม่หยิบชื่อรุ่นอย่าง ProBook หรือข้อความอื่น)
 */
function extractSerialFromOcrText(text) {
    if (!text) return null;
    const cleanText = text.replace(/[\u2010\u2013\u2014]/g, '-');

    // 1. ระดับความสำคัญสูงสุด (Priority 1): มีคีย์เวิร์ดกำกับชัดเจน (Apple Support Style)
    // 🎯 A) เจาะจง Dell ST:XXXXXXX หรือ ST XXXXXXX หรือ Service Tag (เช่น ST:H0XCY 24 บนสติกเกอร์ Dell)
    const dellStMatch = cleanText.match(/\b(?:ST|Service\s*Tag)[:\s#.-]+([A-Z0-9 -]{7,12})/i);
    if (dellStMatch && dellStMatch[1]) {
        let rawCand = dellStMatch[1].replace(/[\s-]/g, '').toUpperCase();
        if (rawCand.length >= 7) {
            rawCand = rawCand.substring(0, 7);
            let cand = disambiguateSerial(rawCand).replace(/O/g, '0').replace(/I/g, '1');
            const matched = findSystemMatchingSn(cand);
            if (matched) {
                return { sn: matched, isLabeled: true };
            }
            if (knownSnSet.size === 0 && isValidSerialNumber(cand)) {
                return { sn: cand, isLabeled: true };
            }
        }
    }

    // 🎯 B) Dell Express Service Code (EX:37061331052 หรือ Express Code) -> แปลงเป็น 7-char Service Tag อัตโนมัติ (เช่น H0XCY24)
    const dellExMatch = cleanText.match(/\b(?:EX|Express)[:\s#.-]+([0-9 -]{10,14})/i);
    if (dellExMatch && dellExMatch[1]) {
        try {
            const rawCand = dellExMatch[1].replace(/[\s-]/g, '');
            if (rawCand.length >= 10 && rawCand.length <= 11) {
                const converted = parseInt(rawCand, 10).toString(36).toUpperCase();
                const matched = findSystemMatchingSn(converted);
                if (matched) {
                    return { sn: matched, isLabeled: true };
                }
                if (knownSnSet.size === 0 && converted.length === 7 && isValidSerialNumber(converted)) {
                    return { sn: converted, isLabeled: true };
                }
            }
        } catch(e) {}
    }

    // C) คีย์เวิร์ดกำกับทั่วไป เช่น "S N #5CD112GPNW" (HP เลเซอร์เคส), "Serial number WVYF59WY7X", "S/N: 5CD 238 M2D5", "Service Tag: 4HG3KL2"
    const labeledPatterns = [
        /(?:Service\s*Tag)[:\s#.-]*([A-Z0-9 -]{7,12})/i,
        /(?:Serial\s*(?:number|no|#|\.)?|S[\s\/\-_.]*N)[:\s#.-]+([A-Z0-9 -]{5,20})/i,
        /(?:S[\s\/\-_.]*N)[\s:#.-]+([A-Z0-9 -]{7,18})/i
    ];

    for (let pattern of labeledPatterns) {
        const match = cleanText.match(pattern);
        if (match && match[1]) {
            let cleaned = match[1].replace(/[\s-]/g, '').toUpperCase();
            let candidate = disambiguateSerial(cleaned);
            const matched = findSystemMatchingSn(candidate);
            if (matched) {
                return { sn: matched, isLabeled: true };
            }
            if (knownSnSet.size === 0 && isValidSerialNumber(candidate)) {
                return { sn: candidate, isLabeled: true };
            }
        }
    }

    // 2. เตรียมรายการคำค้นหา: ทั้งแบบรวมข้อความทั้งบรรทัด (แก้ปัญหาช่องว่างเช่น "SCD 112GPNW" หรือ "HOXCY 24") และแยกทีละคำ
    const lines = cleanText.split(/\r?\n/);
    const candidateTokens = [];

    for (let line of lines) {
        const upperLine = line.toUpperCase();
        if (OCR_BLACKLIST.some(b => upperLine.includes(b))) continue;

        // A) แยกทีละคำ
        const words = line.trim().split(/[\s,;|]+/);
        for (let w of words) {
            const cleanW = w.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
            if (cleanW.length >= 6 && cleanW.length <= 20) {
                candidateTokens.push(cleanW);
            }
        }

        // B) รวมตัวอักษรทั้งบรรทัดโดยตัดเว้นวรรค
        const collapsed = line.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
        if (collapsed.length >= 6 && collapsed.length <= 20) {
            candidateTokens.push(collapsed);
        }
        if (/^ST[A-Z0-9]{7}$/i.test(collapsed)) {
            candidateTokens.push(collapsed.substring(2));
        }

        // C) สกัดกลุ่มตัวอักษร 7 ตัว (Dell Service Tag สไตล์ เช่น BBBHPL3 จาก "🔍 BBBHPL3" หรือป้ายหน้าจอ)
        const sevenMatches = line.match(/[A-Za-z0-9]{7}/g);
        if (sevenMatches) {
            for (let sm of sevenMatches) {
                candidateTokens.push(sm.toUpperCase());
            }
        }
    }

    // 3. ตรวจสอบกับฐานข้อมูลระบบ (System Whitelist Matching) - ความสำคัญสูงสุด
    for (let raw of candidateTokens) {
        const matched = findSystemMatchingSn(raw);
        if (matched) {
            return { sn: matched, isLabeled: false };
        }
    }

    // 4. หากมีฐานข้อมูลระบบ (knownSnSet > 0) แต่ไม่มีคำไหนตรงกับระบบเลย -> คืนค่า null (ไม่สแกนมั่ว)
    if (knownSnSet.size > 0) {
        return null;
    }

    // 5. Fallback เฉพาะเมื่อยังไม่มีฐานข้อมูลในเครื่อง (knownSnSet.size === 0)
    for (let raw of candidateTokens) {
        if (!isValidSerialNumber(raw)) continue;
        let token = disambiguateSerial(raw);
        if (!isValidSerialNumber(token)) continue;

        // A) HP Laptop S/N: 10 ตัวอักษร เริ่มด้วย 5CD, 5CG, CND, 4CE, 8CG, 2CE, CZC, CNU, 3CE
        if (/^(?:5CD|5CG|CND|4CE|8CG|2CE|CZC|CNU|3CE)[A-Z0-9]{7}$/.test(token)) {
            return { sn: token, isLabeled: false };
        }

        // B) Lenovo S/N: 8 ตัวอักษร ขึ้นต้นด้วย PF, MP, PC, 1S
        if (/^(?:PF|MP|PC|1S)[A-Z0-9]{6,8}$/.test(token)) {
            return { sn: token, isLabeled: false };
        }

        // C) ASUS Laptop S/N: 15 ตัวอักษร (เช่น N7NXCV176075305)
        if (/^[A-Z0-9]{15}$/.test(token)) {
            const digitCount = (token.match(/[0-9]/g) || []).length;
            const letterCount = (token.match(/[A-Z]/g) || []).length;
            if (digitCount >= 3 && letterCount >= 2) {
                return { sn: token, isLabeled: false };
            }
        }

        // D) Apple Serial: 10 หรือ 12 ตัวอักษร
        if ((token.length === 10 || token.length === 12) && /[A-Z]/.test(token) && /[0-9]/.test(token)) {
            if (!/^[0-9]+$/.test(token) && !/^[A-Z]+$/.test(token)) {
                return { sn: token, isLabeled: false };
            }
        }

        // E) Dell Service Tag (7 ตัว)
        if (/^[A-Z0-9]{7}$/.test(token)) {
            let dellDisambiguated = token.replace(/O/g, '0').replace(/I/g, '1');
            if (OCR_BLACKLIST.some(b => dellDisambiguated.includes(b))) continue;

            const digitCount = (dellDisambiguated.match(/[0-9]/g) || []).length;
            const letterCount = (dellDisambiguated.match(/[A-Z]/g) || []).length;
            if (digitCount >= 1 && letterCount >= 2) {
                return { sn: dellDisambiguated, isLabeled: false };
            }
        }

        // F) General Notebook / Asset S/N: 8-18 ตัวอักษร มีทั้งตัวอักษรและตัวเลข (เช่น TH49G7D277, 5CD238M2D5)
        if (/^[A-Z0-9]{8,18}$/.test(token)) {
            const digitCount = (token.match(/[0-9]/g) || []).length;
            const letterCount = (token.match(/[A-Z]/g) || []).length;
            if (digitCount >= 1 && letterCount >= 1) {
                return { sn: token, isLabeled: false };
            }
        }

        // G) Long Numeric Serial / Asset / Barcode ID: 9-18 หลักตัวเลขล้วน (เช่น 231215060920112, 240916030520027)
        if (/^[0-9]{9,18}$/.test(token)) {
            // ป้องกันเบอร์มือถือ 10 หลักขึ้นต้นด้วย 06, 08, 09
            if (token.length === 10 && /^(?:06|08|09)/.test(token)) {
                continue;
            }
            return { sn: token, isLabeled: false };
        }
    }

    return null;
}

/**
 * ⚡ กรองและทำความสะอาด Serial Number จากการสแกนบาร์โค้ดแท่ง/คิวอาร์โค้ด (1D/2D)
 * ข้อสำคัญสูงสุด: บาร์โค้ดแท้มี Checksum ดิจิทัลถูกต้อง 100% ห้ามแปลงตัวอักษรเด็ดขาด!
 */
function sanitizeBarcodeSerial(raw) {
    if (!raw) return null;
    let s = String(raw).trim();

    // 1. ดึงเฉพาะ Service Tag หากสแกนโดน Dell Support Tag URL
    if (s.includes('dell.com') || s.includes('tag=') || s.includes('ServiceTag=')) {
        const match = s.match(/(?:tag|ServiceTag)=([A-Z0-9]+)/i);
        if (match && match[1]) return match[1].toUpperCase();
    }

    // 2. ดึง Dell Service Tag จากข้อความบาร์โค้ดแบบ 2D DataMatrix (เช่น ST:H0XCY24 หรือ ST=H0XCY24)
    const stMatch = s.match(/(?:ST|Service\s*Tag)[:=\s]+([A-Z0-9]{7})/i);
    if (stMatch && stMatch[1]) return stMatch[1].toUpperCase();

    // 3. Dell Express Service Code ในบาร์โค้ด (เช่น EX:37061331052 หรือเลข 10-11 หลัก)
    const exMatch = s.match(/(?:EX|Express)[:=\s]+([0-9]{10,11})/i);
    if (exMatch && exMatch[1]) {
        try {
            const converted = parseInt(exMatch[1], 10).toString(36).toUpperCase();
            if (converted.length === 7) return converted;
        } catch(e) {}
    }
    if (/^[0-9]{10,11}$/.test(s)) {
        try {
            const converted = parseInt(s, 10).toString(36).toUpperCase();
            if (converted.length === 7) return converted;
        } catch(e) {}
    }

    // 4. ป้องกันการสแกนโดนบาร์โค้ด MAC Address (อุปกรณ์เราเตอร์/Switch มักมีบาร์โค้ด MAC อยู่ติดกับ S/N)
    if (/^MAC[:\s\-_]/i.test(s) || /^([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2})$/.test(s)) {
        console.warn('⚠️ Scanned MAC Address barcode instead of S/N:', s);
        showToast('⚠️ สแกนโดนบาร์โค้ด MAC Address กรุณาเล็งแถบ S/N', 'warning');
        return null;
    }

    // 5. ดึง Serial Number จากบาร์โค้ดแบบ 2D DataMatrix ตามมาตรฐาน ISO/IEC 15434 ของ HP / Dell / Lenovo (เช่น [)> 06 <GS> 1P3E7X6PA#AKL <GS> S5CD112GPNW หรือ 3E7X6PA#AKL;5CD112GPNW)
    if (s.includes('\x1d') || s.includes(';') || s.includes('\x1e')) {
        const parts = s.split(/[\x1d\x1e\x1f\x04;\r\n]+/);
        for (let p of parts) {
            p = p.trim();
            const snMatch = p.match(/^(?:S|SN|1S)[:\s#]*([A-Z0-9]{7,20})$/i);
            if (snMatch) {
                s = snMatch[1];
                break;
            }
            if (/^(?:(?:5|S)(?:CD|CG|CE)|CND|4CE|8CG)[A-Z0-9]{7}$/i.test(p)) {
                s = p;
                break;
            }
        }
    }

    // 6. ตัดรหัสควบคุมพิเศษของ GS1 / DataMatrix ออก (เช่น [)> 06 \x1e \x1d)
    s = s.replace(/^\[\)>\x1e[0-9]{2}\x1d/i, '').replace(/[\x00-\x1f\x7f]/g, '');

    // 7. ตัด Prefix บาร์โค้ดทั่วไป: (S), S/N:, SN:, SERVICE TAG:, SERNO:, ST:, S, #
    s = s.replace(/^(?:\(S\)|S\/N|SN|SERVICE TAG|SERNO|ST|S)[\s:#.-]*/i, '');
    s = s.replace(/^[#:]+/, '');
    s = s.trim().toUpperCase();

    // 8. ตัด Prefix '1S' ของฮาร์ดแวร์ Lenovo (บาร์โค้ด Lenovo มักมี 1S นำหน้า แต่ในชีตมักบันทึกเฉพาะตัวจริง)
    if (/^1S[A-Z0-9]{7,16}$/.test(s)) {
        s = s.substring(2);
    }

    // 8. กรองคำต้องห้าม & ตรวจสอบความถูกต้อง
    if (OCR_BLACKLIST.some(w => s.includes(w))) return null;
    if (!isValidSerialNumber(s)) return null;

    // 9. ตรวจสอบความยาว S/N ที่ถูกต้อง (4-30 ตัวอักษร)
    if (/^[A-Z0-9\-_]{4,30}$/.test(s)) {
        return s;
    }
    return null;
}

function sanitizeSerial(raw) {
    if (!raw) return null;
    let s = String(raw).trim();

    // Dell Support Tag URL
    if (s.includes('dell.com') || s.includes('tag=') || s.includes('ServiceTag=')) {
        const match = s.match(/(?:tag|ServiceTag)=([A-Z0-9]+)/i);
        if (match && match[1]) return match[1].toUpperCase();
    }

    // Dell ST:XXXXXXX
    const stMatch = s.match(/(?:ST|Service\s*Tag)[:=\s]+([A-Z0-9]{7})/i);
    if (stMatch && stMatch[1]) return stMatch[1].toUpperCase();

    // Dell Express Service Code
    const exMatch = s.match(/(?:EX|Express)[:=\s]+([0-9]{10,11})/i);
    if (exMatch && exMatch[1]) {
        try {
            const converted = parseInt(exMatch[1], 10).toString(36).toUpperCase();
            if (converted.length === 7) return converted;
        } catch(e) {}
    }
    if (/^[0-9]{10,11}$/.test(s)) {
        try {
            const converted = parseInt(s, 10).toString(36).toUpperCase();
            if (converted.length === 7) return converted;
        } catch(e) {}
    }

    s = s.replace(/^(?:S\/N|SN|SERVICE TAG|SERNO|ST)[\s:]*/i, '');
    s = s.trim().toUpperCase();

    if (OCR_BLACKLIST.some(w => s.includes(w))) return null;
    s = disambiguateSerial(s);

    if (isValidSerialNumber(s)) {
        return s;
    }
    return null;
}

/**
 * ถอดรหัสบาร์โค้ดแท่ง (1D/2D) สำเร็จ -> ความแม่นยำ 100% เปิดค้นหาทันที
 */
function handleDetectedBarcode(raw) {
    const cleanSn = sanitizeBarcodeSerial(raw);
    if (!cleanSn) return false;

    // 🛡️ System Whitelist Gating: ต้องมี S/N ในระบบชีตเท่านั้น จึงจะเริ่มทำงาน
    const matchedSn = findSystemMatchingSn(cleanSn);
    if (!matchedSn) {
        return false;
    }
    const targetSn = matchedSn;

    const now = Date.now();
    const cooldownMs = cameraScanMode === 'single' ? 1200 : 1800;
    if (targetSn === lastScannedCode && (now - lastScannedTime) < cooldownMs) {
        return false;
    }

    lastScannedCode = targetSn;
    lastScannedTime = now;

    // Audio Beep
    playBeepSound();

    // Haptic Vibration
    if (navigator.vibrate) {
        try { navigator.vibrate([60, 30, 60]); } catch(e) {}
    }

    // Reticle Green Flash
    triggerReticleFlash();

    // แสดงป้าย S/N ที่ยิงได้บนหน้าจอกล้องแบบ Live Pill เพื่อให้เห็นชัดเจนว่ากล้องจับเลขอะไร
    const pill = document.getElementById('reticle-ocr-pill');
    const pillText = document.getElementById('reticle-ocr-text');
    if (pill && pillText) {
        pillText.textContent = `🎯 ${targetSn}`;
        pill.classList.remove('opacity-0');
        setTimeout(() => {
            if (pill && cameraScanMode === 'continuous') pill.classList.add('opacity-0');
        }, 1500);
    }

    // Add to recent list
    saveRecentScan(targetSn);

    // ⚡ หากเปิดโหมดยิงต่อเนื่อง (Continuous Gun Mode) ให้สะสมเข้าชุดพร้อมแสดงสรุปแบบรูปที่ 2 ทันที (กล้องไม่เด้งปิด)
    if (cameraScanMode === 'continuous') {
        handleContinuousGunScannedBarcode(targetSn);
        return true;
    }

    // Look up device immediately! (โหมดยิงทีละเครื่อง Single Mode)
    lookupDeviceBySn(targetSn);
    return true;
}

/**
 * ถอดรหัสตัวหนังสือ Live Text OCR สไตล์ Apple Support
 * สแกนและเปิดข้อมูลเครื่องตรงๆ ทันที (Direct Instant Lookup) ไม่เด้งไปหน้าพิมพ์มือ
 */
function handleDetectedOcrSerial(cleanSn) {
    if (!cleanSn) return false;

    // 🛡️ System Whitelist Gating: ต้องมี S/N ในระบบชีตเท่านั้น จึงจะเริ่มทำงาน
    const matchedSn = findSystemMatchingSn(cleanSn);
    if (!matchedSn) {
        return false;
    }
    const targetSn = matchedSn;

    const now = Date.now();
    const cooldownMs = cameraScanMode === 'single' ? 1200 : 1800;
    if (targetSn === lastScannedCode && (now - lastScannedTime) < cooldownMs) {
        return false;
    }

    lastScannedCode = targetSn;
    lastScannedTime = now;

    // Beep & Haptic
    playBeepSound();
    if (navigator.vibrate) {
        try { navigator.vibrate([60, 40, 60]); } catch(e) {}
    }
    triggerReticleFlash();

    // แสดงป้าย S/N ที่ยิงได้บนหน้าจอกล้องแบบ Live Pill เพื่อให้เห็นชัดเจนว่ากล้องจับเลขอะไร
    const pill = document.getElementById('reticle-ocr-pill');
    const pillText = document.getElementById('reticle-ocr-text');
    if (pill && pillText) {
        pillText.textContent = `🎯 ${targetSn}`;
        pill.classList.remove('opacity-0');
        setTimeout(() => {
            if (pill && cameraScanMode === 'continuous') pill.classList.add('opacity-0');
        }, 1500);
    }

    // Add to recent list
    saveRecentScan(targetSn);

    // ⚡ หากเปิดโหมดยิงต่อเนื่อง (Continuous Gun Mode) ให้สะสมเข้าชุดพร้อมแสดงสรุปทันที
    if (cameraScanMode === 'continuous') {
        handleContinuousGunScannedBarcode(targetSn);
        return true;
    }

    // ⚡ ยิงตรงเข้าสู่หน้าค้นหาเครื่องทันที (Instant Direct Lookup) ไม่เด้งไปหน้าพิมพ์มือ
    lookupDeviceBySn(targetSn);
    return true;
}

function cancelOcrAutoAdvance() {
    if (ocrAutoAdvanceTimer) {
        clearTimeout(ocrAutoAdvanceTimer);
        ocrAutoAdvanceTimer = null;
    }
    if (ocrCountdownInterval) {
        clearInterval(ocrCountdownInterval);
        ocrCountdownInterval = null;
    }
    const alertBox = document.getElementById('manual-ocr-detected-alert');
    if (alertBox) alertBox.classList.add('hidden');
}

function triggerReticleFlash() {
    const reticle = document.getElementById('scanner-reticle');
    if (reticle) {
        reticle.classList.add('reticle-hit');
        setTimeout(() => reticle.classList.remove('reticle-hit'), 350);
    }
}

function playBeepSound() {
    try {
        if (!beepAudioCtx) {
            const AudioContext = window.AudioContext || window.webkitAudioContext;
            if (AudioContext) beepAudioCtx = new AudioContext();
        }
        if (!beepAudioCtx) return;
        if (beepAudioCtx.state === 'suspended') beepAudioCtx.resume();

        const ctx = beepAudioCtx;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(1760, ctx.currentTime);
        gain.gain.setValueAtTime(0.25, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.08);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.08);
    } catch(e) {}
}

// =========================================================================
// 📸 Photo Capture & File Decoder (100% Accuracy with Quiet Zone)
// =========================================================================
function triggerNativeCapture() {
    const input = document.getElementById('scanner-file-input');
    if (input) {
        input.value = '';
        input.click();
    }
}

function triggerGalleryPick() {
    const input = document.getElementById('scanner-gallery-input');
    if (input) {
        input.value = '';
        input.click();
    }
}

async function handleFileSelected(event) {
    const files = event.target.files;
    if (!files || files.length === 0) return;
    const file = files[0];

    const overlay = document.getElementById('scanner-status-overlay');
    if (overlay) {
        overlay.classList.remove('hidden');
        overlay.innerHTML = `
            <div class="flex flex-col items-center gap-2">
                <span class="text-3xl animate-spin">⏳</span>
                <span class="text-sm font-bold text-white">กำลังอ่านบาร์โค้ดจากภาพถ่าย...</span>
                <span class="text-xs text-blue-300">ระบบถอดรหัสความเร็วสูง</span>
            </div>
        `;
    }

    try {
        const decoded = await decodeBarcodeFromImageFile(file);
        if (decoded) {
            if (overlay) overlay.classList.add('hidden');
            handleDetectedBarcode(decoded);
        } else {
            if (overlay) {
                overlay.innerHTML = `
                    <div class="flex flex-col items-center gap-2 max-w-xs text-center">
                        <span class="text-2xl text-neutral-400">🔍</span>
                        <div class="text-sm font-bold text-white">ไม่พบบาร์โค้ดในภาพถ่าย</div>
                        <div class="text-xs text-neutral-400">จัดให้เห็นสติกเกอร์บาร์โค้ดชัดเจน หรือป้อนด้วยตนเอง</div>
                        <div class="flex items-center gap-2 mt-2 w-full">
                            <button type="button" onclick="triggerNativeCapture()" class="flex-1 py-2 px-3 bg-blue-600 hover:bg-blue-500 text-white rounded-xl text-xs font-bold shadow-md">
                                📸 ถ่ายใหม่
                            </button>
                            <button type="button" onclick="switchScannerMode('manual')" class="flex-1 py-2 px-3 bg-neutral-800 hover:bg-neutral-700 text-white rounded-xl text-xs font-semibold">
                                ⌨️ ป้อนเอง
                            </button>
                        </div>
                    </div>
                `;
            }
        }
    } catch(err) {
        if (overlay) overlay.classList.add('hidden');
    }
}

function tryDecodeRegionWithQuietZone(reader, srcCanvas, sx, sy, sw, sh, rotateDeg) {
    if (!reader || !srcCanvas || sw <= 20 || sh <= 10) return null;
    try {
        const pad = 35;
        const padded = document.createElement('canvas');
        padded.width = sw + pad * 2;
        padded.height = sh + pad * 2;
        const pctx = padded.getContext('2d', { willReadFrequently: true });
        pctx.fillStyle = '#ffffff';
        pctx.fillRect(0, 0, padded.width, padded.height);

        if (rotateDeg) {
            pctx.save();
            pctx.translate(padded.width / 2, padded.height / 2);
            pctx.rotate((rotateDeg * Math.PI) / 180);
            pctx.drawImage(srcCanvas, sx, sy, sw, sh, -sw / 2, -sh / 2, sw, sh);
            pctx.restore();
        } else {
            pctx.drawImage(srcCanvas, sx, sy, sw, sh, pad, pad, sw, sh);
        }

        const res = reader.decodeFromCanvas(padded);
        if (res) {
            const raw = res.getText ? res.getText() : res.text;
            const clean = sanitizeSerial(raw);
            if (clean) return clean;
        }
    } catch(e) {}
    return null;
}

async function decodeBarcodeFromImageFile(file) {
    if (!file) return null;
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = async (e) => {
            const img = new Image();
            img.onload = async () => {
                let decoded = null;

                // 1. Native GPU Detector
                if (barcodeDetector) {
                    try {
                        const results = await barcodeDetector.detect(img);
                        if (results && results.length > 0) {
                            for (let i = 0; i < results.length; i++) {
                                if (results[i] && results[i].rawValue) {
                                    const clean = sanitizeSerial(results[i].rawValue);
                                    if (clean) { decoded = clean; break; }
                                }
                            }
                        }
                    } catch(e) {}
                }

                // 2. ZXing Multi-Tier with Quiet Zone
                if (!decoded && typeof ZXing !== 'undefined' && ZXing.BrowserMultiFormatReader) {
                    try {
                        if (!zxingReader) zxingReader = new ZXing.BrowserMultiFormatReader();
                        const maxDim = 1600;
                        let scale = 1;
                        if (img.width > maxDim || img.height > maxDim) {
                            scale = maxDim / Math.max(img.width, img.height);
                        }
                        const w = Math.round(img.width * scale);
                        const h = Math.round(img.height * scale);

                        const canvas = document.createElement('canvas');
                        canvas.width = w;
                        canvas.height = h;
                        const ctx = canvas.getContext('2d', { willReadFrequently: true });
                        ctx.drawImage(img, 0, 0, w, h);

                        // White paper detection
                        try {
                            const imgData = ctx.getImageData(0, 0, w, h);
                            const data = imgData.data;
                            let minX = w, maxX = 0, minY = h, maxY = 0, brightCount = 0;
                            for (let y = 0; y < h; y += 4) {
                                for (let x = 0; x < w; x += 4) {
                                    const idx = (y * w + x) * 4;
                                    if (data[idx] > 155 && data[idx+1] > 155 && data[idx+2] > 155) {
                                        if (x < minX) minX = x;
                                        if (x > maxX) maxX = x;
                                        if (y < minY) minY = y;
                                        if (y > maxY) maxY = y;
                                        brightCount++;
                                    }
                                }
                            }
                            if (brightCount > 30 && maxX > minX + 40 && maxY > minY + 20) {
                                const sw = maxX - minX;
                                const sh = maxY - minY;
                                decoded = tryDecodeRegionWithQuietZone(zxingReader, canvas, minX, minY, sw, sh, 0);
                            }
                        } catch(paperErr) {}

                        // Center crops
                        if (!decoded) {
                            const tiers = [
                                { w: 0.70, h: 0.45, yOff: 0.35 },
                                { w: 0.85, h: 0.50, yOff: 0.25 },
                                { w: 1.00, h: 1.00, yOff: 0.00 }
                            ];
                            for (let t = 0; t < tiers.length; t++) {
                                const tier = tiers[t];
                                const cw = Math.floor(w * tier.w);
                                const ch = Math.floor(h * tier.h);
                                const cx = Math.floor((w - cw) / 2);
                                const cy = Math.floor(h * tier.yOff);
                                decoded = tryDecodeRegionWithQuietZone(zxingReader, canvas, cx, cy, cw, ch, 0);
                                if (decoded) break;
                            }
                        }
                    } catch(zxErr) {}
                }

                // 3. 🤖 Apple-Style Live Text OCR Fallback (if no barcode found on image)
                if (!decoded && (ocrWorker || typeof Tesseract !== 'undefined')) {
                    try {
                        const worker = ocrWorker || await Tesseract.createWorker('eng');
                        const ocrRes = await worker.recognize(img);
                        if (ocrRes && ocrRes.data && ocrRes.data.text) {
                            const detected = extractSerialFromOcrText(ocrRes.data.text);
                            if (detected && detected.sn) {
                                decoded = detected.sn;
                                console.log('🎉 OCR Detected Serial Number from Image:', decoded);
                            }
                        }
                    } catch(ocrFileErr) {
                        console.warn('OCR image file error:', ocrFileErr);
                    }
                }

                resolve(decoded);
            };
            img.onerror = () => reject(new Error('Image load failed'));
            img.src = e.target.result;
        };
        reader.readAsDataURL(file);
    });
}

// =========================================================================
// ⌨️ Manual Entry Mode (Apple Support Style)
// =========================================================================
window.switchScannerMode = function(mode) {
    scannerMode = mode;
    const camView = document.getElementById('scanner-view-camera');
    const manView = document.getElementById('scanner-view-manual');

    if (mode === 'manual') {
        if (camView) camView.classList.add('hidden');
        if (manView) manView.classList.remove('hidden');
        stopLiveCamera();

        const input = document.getElementById('manual-sn-input');
        if (input) {
            handleManualInputChange();
            setTimeout(() => {
                try { input.focus(); } catch(e) {}
            }, 100);
        }
    } else {
        if (manView) manView.classList.add('hidden');
        if (camView) camView.classList.remove('hidden');
        startLiveCamera();
    }
};

window.handleManualInputChange = function() {
    cancelOcrAutoAdvance();
    const input = document.getElementById('manual-sn-input');
    const btn = document.getElementById('btn-manual-next');
    if (!btn) return;

    const hasVal = input && input.value && input.value.trim().length > 0;
    if (hasVal) {
        btn.classList.remove('opacity-40', 'cursor-not-allowed');
        btn.classList.add('bg-blue-600', 'hover:bg-blue-500', 'text-white', 'cursor-pointer');
        btn.removeAttribute('disabled');
    } else {
        btn.classList.add('opacity-40', 'cursor-not-allowed');
        btn.classList.remove('bg-blue-600', 'hover:bg-blue-500');
        btn.setAttribute('disabled', 'true');
    }
};

window.clearManualInput = function() {
    cancelOcrAutoAdvance();
    const input = document.getElementById('manual-sn-input');
    if (input) {
        input.value = '';
        handleManualInputChange();
        try { input.focus(); } catch(e) {}
    }
};

window.toggleCharInManualInput = function(charA, charB) {
    cancelOcrAutoAdvance();
    const input = document.getElementById('manual-sn-input');
    if (!input || !input.value) return;
    let val = input.value.toUpperCase();
    
    if (val.includes(charA)) {
        input.value = val.replace(new RegExp(charA, 'g'), charB);
    } else if (val.includes(charB)) {
        input.value = val.replace(new RegExp(charB, 'g'), charA);
    }
    handleManualInputChange();
    if (navigator.vibrate) {
        try { navigator.vibrate(40); } catch(e) {}
    }
};

window.submitManualSerial = function() {
    cancelOcrAutoAdvance();
    const input = document.getElementById('manual-sn-input');
    if (!input || !input.value) return;
    const val = input.value.trim();
    if (!val) return;

    let clean = sanitizeSerial(val);
    if (!clean) clean = val.toUpperCase().replace(/\s+/g, '');

    input.value = '';
    handleManualInputChange();
    saveRecentScan(clean);
    lookupDeviceBySn(clean);
};

// =========================================================================
// ⚡ Bulk Barcode Scanner (โหมดปืนยิงสแกนเนอร์ต่อเนื่องหลายเครื่อง)
// =========================================================================
let lastBulkManualCount = 0;

window.switchManualSubmode = function(submode) {
    const tabSingle = document.getElementById('tab-sub-single');
    const tabBulk = document.getElementById('tab-sub-bulk');
    const boxSingle = document.getElementById('box-sub-single');
    const boxBulk = document.getElementById('box-sub-bulk');
    const btnNext = document.getElementById('btn-manual-next');

    if (submode === 'bulk') {
        if (tabBulk) tabBulk.className = "flex-1 py-1.5 rounded-xl bg-blue-600 text-white transition-all cursor-pointer";
        if (tabSingle) tabSingle.className = "flex-1 py-1.5 rounded-xl text-neutral-400 hover:text-white transition-all cursor-pointer";
        if (boxBulk) {
            boxBulk.classList.remove('hidden');
            boxBulk.classList.add('flex');
        }
        if (boxSingle) boxSingle.classList.add('hidden');
        if (btnNext) btnNext.classList.add('hidden');
        setTimeout(() => {
            const ta = document.getElementById('bulk-manual-textarea');
            if (ta) ta.focus();
        }, 100);
    } else {
        if (tabSingle) tabSingle.className = "flex-1 py-1.5 rounded-xl bg-blue-600 text-white transition-all cursor-pointer";
        if (tabBulk) tabBulk.className = "flex-1 py-1.5 rounded-xl text-neutral-400 hover:text-white transition-all cursor-pointer";
        if (boxSingle) boxSingle.classList.remove('hidden');
        if (boxBulk) {
            boxBulk.classList.add('hidden');
            boxBulk.classList.remove('flex');
        }
        if (btnNext) btnNext.classList.remove('hidden');
        setTimeout(() => {
            const inp = document.getElementById('manual-sn-input');
            if (inp) inp.focus();
        }, 100);
    }
};

// =========================================================================
// ⚡ Continuous Barcode Scanner Gun & Live Preview Feed (สไตล์รูปที่ 2)
// =========================================================================

// In-Memory Cache เพื่อการแสดงผล 0ms เมื่อยิงซ้ำ
const localSnDetailCache = new Map();

function escapeHtml(str) {
    if (!str && str !== 0) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

/**
 * 🏷️ ตรวจสอบว่าสินค้าเป็นเครื่องที่ตัดขายแล้ว (Sell) หรือไม่
 * ตรวจจาก quotation (เช่น "ราคาขาย: 8,700 บาท"), company (เช่น "ลูกค้าร้าน", "ขายหน้าร้าน"), status, stock, sheet, remark
 */
function isAssetSold(item) {
    if (!item) return false;
    const q = String(item.quotation || item.quote || '').toLowerCase();
    const comp = String(item.company || item.comp || '').toLowerCase();
    const st = String(item.status || '').toLowerCase();
    const stk = String(item.stock || item.sheet || '').toLowerCase();
    const rem = String(item.remark || '').toLowerCase();

    // 1. ตรวจจาก Quotation
    if (q.includes('ราคาขาย') || q.includes('ตัดขาย') || q.includes('ซื้อขาด') || q.includes('ขายสด') || q.includes('ขายขาด') || q.includes('sell') || q.includes('sold')) {
        return true;
    }
    // 2. ตรวจจากชื่อบริษัท / ลูกค้า
    if (comp.includes('ตัดขาย') || comp.includes('ขายหน้าร้าน') || comp.includes('ลูกค้าร้าน') || comp.includes('ซื้อขาด') || comp.includes('ขายแล้ว') || comp.includes('sell') || comp.includes('sold')) {
        return true;
    }
    // 3. ตรวจจาก Status
    if (st.includes('sell') || st.includes('sold') || st.includes('ตัดขาย') || st.includes('ขายแล้ว') || st.includes('ขายขาด')) {
        return true;
    }
    // 4. ตรวจจาก Stock / คลัง / Sheet
    if (stk.includes('stock sell') || stk.includes('sell') || stk.includes('ตัดขาย')) {
        return true;
    }
    // 5. ตรวจจาก Remark / หมายเหตุ
    if (rem.includes('ตัดขาย') || rem.includes('ขายหน้าร้าน') || rem.includes('ขายแล้ว')) {
        return true;
    }
    return false;
}

/**
 * สร้าง HTML Card แสดงรายละเอียดเครื่องที่ยิงตามสถานะ (ตรงตามรูปที่ 2)
 */
function createScannedItemCardHtml(item, index, isDupInInput) {
    const sn = item.sn || '-';
    const model = (item.model && item.model !== '-' && item.model !== 'null') ? item.model : '-';
    const company = (item.company && item.company !== '-' && item.company.toLowerCase() !== 'null') 
        ? item.company 
        : ((item.comp && item.comp !== '-' && item.comp.toLowerCase() !== 'null') ? item.comp : '-');
    const quotation = (item.quotation && item.quotation !== '-' && item.quotation.toLowerCase() !== 'null') 
        ? item.quotation 
        : ((item.quote && item.quote !== '-' && item.quote.toLowerCase() !== 'null') ? item.quote : 'ไม่มี');
    const isSold = isAssetSold(item);
    const stock = isSold ? 'Stock Sell' : (item.stock || item.sheet || 'ในระบบ');

    let cardBg = 'bg-[#1c1c1e] border-neutral-800 text-neutral-300';
    let icon = '⚪';
    let statusBadge = '';

    if (isDupInInput) {
        cardBg = 'bg-amber-950/20 border-amber-500/40 text-amber-200';
        icon = '⚠️';
        statusBadge = '<span class="px-2 py-0.5 rounded-md text-[10px] font-black bg-amber-500/20 text-amber-300 border border-amber-500/30">⚠️ สแกนซ้ำในรายการ</span>';
    } else if (item.loading) {
        cardBg = 'bg-neutral-900 border-neutral-800 text-neutral-400';
        icon = '⏳';
        statusBadge = '<span class="px-2 py-0.5 rounded-md text-[10px] font-bold bg-neutral-800 text-neutral-300 border border-neutral-700 animate-pulse">กำลังดึงข้อมูล...</span>';
    } else if (item.notFound) {
        cardBg = 'bg-rose-950/20 border-rose-500/40 text-rose-200';
        icon = '❌';
        statusBadge = '<span class="px-2 py-0.5 rounded-md text-[10px] font-black bg-rose-500/20 text-rose-300 border border-rose-500/30">ไม่พบในระบบชีต</span>';
    } else if (isSold) {
        // 🏷️ เครื่องที่ตัดขายไปแล้ว (Sell) แสดงป้ายสีแดง/โรสชัดเจน
        cardBg = 'bg-rose-950/25 border-rose-500/50 text-rose-200';
        icon = '🏷️';
        statusBadge = '<span class="px-2 py-0.5 rounded-md text-[10px] font-black bg-rose-500/20 text-rose-300 border border-rose-500/40">🏷️ Sell (ตัดขายแล้ว)</span>';
    } else {
        const hasContract = (company !== '-' && company !== '') || (quotation !== 'ไม่มี' && quotation !== '-');
        
        // กำหนดสีและสไตล์ของป้าย Stock ตามประเภทคลัง
        let stockBadgeStyle = 'text-amber-300 bg-amber-500/15 border-amber-500/30';
        const lowerStock = stock.toLowerCase();
        if (lowerStock.includes('new')) {
            stockBadgeStyle = 'text-cyan-300 bg-cyan-500/15 border-cyan-500/30';
        } else if (lowerStock.includes('used')) {
            stockBadgeStyle = 'text-pink-300 bg-pink-500/15 border-pink-500/30';
        } else if (lowerStock.includes('sell') || lowerStock.includes('sold')) {
            stockBadgeStyle = 'text-rose-300 bg-rose-500/15 border-rose-500/30';
        } else if (lowerStock.includes('rent')) {
            stockBadgeStyle = 'text-emerald-300 bg-emerald-500/15 border-emerald-500/30';
        }

        if (hasContract) {
            cardBg = 'bg-emerald-950/20 border-emerald-500/40 text-emerald-200';
            icon = '🟢';
            statusBadge = `<span class="px-2 py-0.5 rounded-md text-[10px] font-black bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">🟢 ติดเช่า (${escapeHtml(stock)})</span>`;
        } else {
            // ว่างในสต็อก (ระบุชื่อ Stock / คลังชัดเจน)
            cardBg = 'bg-neutral-900/90 border-neutral-700/80 text-neutral-300';
            icon = '⚪';
            statusBadge = `<span class="px-2 py-0.5 rounded-md text-[10px] font-black ${stockBadgeStyle} border">⚪ ว่างในสต็อก (${escapeHtml(stock)})</span>`;
        }
    }

    // สีข้อความ Stock ในแถวรายละเอียด
    const stockTextColor = stock.toLowerCase().includes('new') ? 'text-cyan-300'
        : (stock.toLowerCase().includes('used') ? 'text-pink-300'
        : (stock.toLowerCase().includes('sell') || stock.toLowerCase().includes('sold') ? 'text-rose-400' : 'text-amber-300'));

    return `
    <div class="p-2.5 rounded-xl border ${cardBg} text-xs transition-all flex flex-col gap-1.5 shadow-sm">
        <div class="flex items-center justify-between font-bold gap-2">
            <span class="font-mono text-xs tracking-wide flex items-center gap-1.5 truncate">
                <span class="text-sm">${icon}</span>
                <span class="text-neutral-400 font-normal">#${index}.</span>
                <span class="font-bold text-white">${escapeHtml(sn)}</span>
            </span>
            <div class="shrink-0">${statusBadge}</div>
        </div>
        <div class="text-[11px] leading-relaxed pl-2 border-l-2 border-neutral-700/70 text-neutral-400 flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span>📦 <b>Stock:</b> <span class="${stockTextColor} font-bold">${escapeHtml(stock)}</span></span>
            <span class="text-neutral-600">|</span>
            <span>🏢 <b>บริษัท:</b> <span class="${company !== '-' ? 'text-white font-semibold' : 'text-neutral-500'}">${escapeHtml(company)}</span></span>
            <span class="text-neutral-600">|</span>
            <span>📄 <b>Q.:</b> <span class="${quotation !== 'ไม่มี' && quotation !== '-' ? 'text-white font-semibold' : 'text-neutral-500'}">${escapeHtml(quotation)}</span></span>
            <span class="text-neutral-600">|</span>
            <span>💻 <b>Model:</b> <span class="${model !== '-' ? 'text-emerald-400 font-medium' : 'text-neutral-500'}">${escapeHtml(model)}</span></span>
        </div>
    </div>`;
}

/**
 * ⚡ ระบบ Batch Lookup ดึงข้อมูล S/N หลายตัวพร้อมกันใน 1 คำขอ
 */
async function lookupBatchSns(snList, onUpdateCallback) {
    if (!snList || snList.length === 0) return;

    const uncached = [];
    snList.forEach(sn => {
        const clean = sn.toUpperCase();
        if (!localSnDetailCache.has(clean)) {
            uncached.push(clean);
        }
    });

    // 1. ลองค้นจาก IndexedDB ก่อน (ออฟไลน์ 0ms)
    for (let i = 0; i < uncached.length; i++) {
        const s = uncached[i];
        const dbItem = await getCachedAssetBySn(s);
        if (dbItem) {
            localSnDetailCache.set(s, dbItem);
        }
    }

    const stillMissing = uncached.filter(s => !localSnDetailCache.has(s));

    if (onUpdateCallback) onUpdateCallback();

    if (stillMissing.length === 0 || !apiUrl) {
        return;
    }

    // 2. เรียก API Gateway แบบชุด (Batch)
    try {
        const postData = {
            action: 'lookupSnBatch',
            snList: stillMissing
        };
        const res = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify(postData)
        });
        const data = await res.json();
        if (data && data.success && data.map) {
            Object.keys(data.map).forEach(searchedSn => {
                const item = data.map[searchedSn];
                if (item) {
                    if (isAssetSold(item)) {
                        item.status = 'Sell';
                        item.stock = 'Stock Sell';
                    }
                    localSnDetailCache.set(searchedSn.toUpperCase(), item);
                    saveAssetToCache(item);
                }
            });
            // เครื่องที่ชีตหาไม่พบ ให้จำว่า Not Found
            stillMissing.forEach(s => {
                if (!localSnDetailCache.has(s)) {
                    localSnDetailCache.set(s, { sn: s, notFound: true, model: '-', company: '-', quotation: 'ไม่มี', status: 'Not Found' });
                }
            });
        } else {
            // Fallback: ดึงทีละตัวถ้า Gateway ยังไม่ได้อัปเดต Batch
            for (let j = 0; j < Math.min(stillMissing.length, 12); j++) {
                const s = stillMissing[j];
                try {
                    const r = await fetch(`${apiUrl}?action=lookupSn&sn=${encodeURIComponent(s)}`);
                    const d = await r.json();
                    if (d && d.success && d.item) {
                        if (isAssetSold(d.item)) {
                            d.item.status = 'Sell';
                            d.item.stock = 'Stock Sell';
                        }
                        localSnDetailCache.set(s, d.item);
                        saveAssetToCache(d.item);
                    } else {
                        localSnDetailCache.set(s, { sn: s, notFound: true, model: '-', company: '-', quotation: 'ไม่มี', status: 'Not Found' });
                    }
                } catch(e) {}
            }
        }
    } catch(err) {
        console.warn('Batch lookup error:', err);
    }

    if (onUpdateCallback) onUpdateCallback();
}

// -------------------------------------------------------------------------
// 📷 Continuous Camera Barcode Gun Logic
// -------------------------------------------------------------------------
let cameraScanMode = 'single'; // 'single' | 'continuous'
let continuousGunList = []; // [{ sn, model, company, quotation, status, loading, notFound }]

window.switchCameraScanMode = function(mode) {
    cameraScanMode = mode;
    lastScannedCode = '';
    lastScannedTime = 0;
    candidateOcrSn = null;
    candidateOcrCount = 0;
    const btnSingle = document.getElementById('cam-sub-single');
    const btnGun = document.getElementById('cam-sub-gun');
    const lowerSingle = document.getElementById('scanner-lower-single');
    const lowerGun = document.getElementById('scanner-lower-gun');
    const modeBadge = document.getElementById('reticle-mode-badge');
    const viewFinder = document.getElementById('scanner-viewfinder-box');

    if (mode === 'continuous') {
        if (btnGun) {
            btnGun.classList.remove('text-neutral-400');
            btnGun.classList.add('bg-blue-600', 'text-white', 'shadow-sm');
        }
        if (btnSingle) {
            btnSingle.classList.remove('bg-blue-600', 'text-white', 'shadow-sm');
            btnSingle.classList.add('text-neutral-400');
        }
        if (lowerSingle) lowerSingle.classList.add('hidden');
        if (lowerGun) lowerGun.classList.remove('hidden');
        if (modeBadge) modeBadge.classList.remove('hidden');
        if (viewFinder) {
            viewFinder.classList.remove('aspect-[4/3]');
            viewFinder.classList.add('aspect-[16/10]');
        }
        renderContinuousGunFeed();
    } else {
        if (btnSingle) {
            btnSingle.classList.remove('text-neutral-400');
            btnSingle.classList.add('bg-blue-600', 'text-white', 'shadow-sm');
        }
        if (btnGun) {
            btnGun.classList.remove('bg-blue-600', 'text-white', 'shadow-sm');
            btnGun.classList.add('text-neutral-400');
        }
        if (lowerGun) lowerGun.classList.add('hidden');
        if (lowerSingle) lowerSingle.classList.remove('hidden');
        if (modeBadge) modeBadge.classList.add('hidden');
        if (viewFinder) {
            viewFinder.classList.remove('aspect-[16/10]');
            viewFinder.classList.add('aspect-[4/3]');
        }
    }
};

async function handleContinuousGunScannedBarcode(cleanSn) {
    // ป้องกันการยิงซ้ำ S/N เดิมในชุดนี้
    const isAlreadyScanned = continuousGunList.some(item => item.sn === cleanSn);
    if (isAlreadyScanned) {
        playBeepSound();
        if (navigator.vibrate) {
            try { navigator.vibrate([100, 50, 100]); } catch(e) {}
        }
        showReticlePill('⚠️ ยิงซ้ำในชุดนี้แล้ว: ' + cleanSn);
        return;
    }

    showReticlePill('⚡ สแกน: ' + cleanSn);

    // 1. ตรวจสอบใน IndexedDB หรือ Cache ทันที (0ms Instant Lookup)
    let cached = localSnDetailCache.get(cleanSn);
    if (!cached) {
        cached = await getCachedAssetBySn(cleanSn);
        if (cached) localSnDetailCache.set(cleanSn, cached);
    }

    if (cached) {
        continuousGunList.unshift({
            sn: cleanSn,
            model: cached.model || cached.name || '-',
            company: cached.company || cached.comp || '-',
            quotation: cached.quotation || cached.quote || '-',
            status: cached.status || 'Available',
            stock: cached.stock || cached.sheet || 'ในระบบ',
            notFound: Boolean(cached.notFound)
        });
        renderContinuousGunFeed();
    } else {
        continuousGunList.unshift({
            sn: cleanSn,
            loading: true,
            model: 'กำลังดึงข้อมูล...',
            company: '-',
            quotation: '-',
            status: 'Loading'
        });
        renderContinuousGunFeed();

        // ค้นหาข้อมูลแบบชุด
        lookupBatchSns([cleanSn], () => {
            continuousGunList.forEach(item => {
                const d = localSnDetailCache.get(item.sn);
                if (d) {
                    item.loading = false;
                    item.model = d.model || '-';
                    item.company = d.company || d.comp || '-';
                    item.quotation = d.quotation || d.quote || '-';
                    item.status = d.status || 'Available';
                    item.stock = d.stock || d.sheet || 'ในระบบ';
                    item.notFound = Boolean(d.notFound);
                }
            });
            renderContinuousGunFeed();
        });
    }
}

function showReticlePill(text) {
    const pill = document.getElementById('reticle-ocr-pill');
    const txt = document.getElementById('reticle-ocr-text');
    if (pill && txt) {
        txt.textContent = text;
        pill.classList.remove('opacity-0');
        setTimeout(() => {
            pill.classList.add('opacity-0');
        }, 1800);
    }
}

function renderContinuousGunFeed() {
    const countEl = document.getElementById('cam-gun-count');
    const rentEl = document.getElementById('cam-gun-rent-count');
    const stockEl = document.getElementById('cam-gun-stock-count');
    const notfoundEl = document.getElementById('cam-gun-notfound-count');
    const btnCountEl = document.getElementById('cam-gun-btn-count');
    const feedList = document.getElementById('cam-gun-feed-list');
    const loadingBadge = document.getElementById('cam-gun-loading-badge');

    const total = continuousGunList.length;
    let rentCount = 0;
    let stockCount = 0;
    let notfoundCount = 0;
    let isLoading = false;

    continuousGunList.forEach(item => {
        if (item.loading) {
            isLoading = true;
        } else if (item.notFound) {
            notfoundCount++;
        } else if (isAssetSold(item)) {
            // 🏷️ เครื่องที่ขายแล้ว (Sell) นับรวมในสต็อก/ขาย ไม่ใช่ติดเช่า
            stockCount++;
        } else {
            const hasContract = (item.company && item.company !== '-' && item.company.toLowerCase() !== 'null') ||
                                (item.quotation && item.quotation !== '-' && item.quotation !== 'ไม่มี');
            if (hasContract) rentCount++;
            else stockCount++;
        }
    });

    if (countEl) countEl.textContent = total;
    if (rentEl) rentEl.textContent = rentCount;
    if (stockEl) stockEl.textContent = stockCount;
    if (notfoundEl) notfoundEl.textContent = notfoundCount;
    if (btnCountEl) btnCountEl.textContent = total;
    if (loadingBadge) {
        if (isLoading) loadingBadge.classList.remove('hidden');
        else loadingBadge.classList.add('hidden');
    }

    if (!feedList) return;

    if (total === 0) {
        feedList.innerHTML = `
            <div id="cam-gun-empty-state" class="p-4 rounded-2xl bg-neutral-900/50 border border-neutral-800/60 text-center text-neutral-500 text-xs">
                🔫 ส่องกล้องไปที่บาร์โค้ดเพื่อยิงได้รัวๆ รายการจะไหลขึ้นมาที่นี่ทันที
            </div>`;
        return;
    }

    const htmlCards = continuousGunList.map((item, idx) => {
        return createScannedItemCardHtml(item, total - idx, false);
    }).join('');

    feedList.innerHTML = htmlCards;
}

let clearGunConfirmTimer = null;

window.clearContinuousGunList = function() {
    if (continuousGunList.length === 0) {
        showToast('ℹ️ ยังไม่มีรายการที่ต้องล้าง', 'info');
        return;
    }

    const btn = document.getElementById('cam-gun-clear-btn');
    if (btn && !btn.dataset.confirming) {
        btn.dataset.confirming = 'true';
        btn.dataset.origHtml = btn.innerHTML;
        btn.innerHTML = '⚠️ ยืนยันล้าง?';
        btn.className = 'px-3 py-2.5 bg-rose-600 hover:bg-rose-500 active:scale-95 text-white font-bold rounded-xl text-xs shadow-md transition-all animate-pulse cursor-pointer';

        clearGunConfirmTimer = setTimeout(() => {
            if (btn && btn.dataset.confirming) {
                delete btn.dataset.confirming;
                btn.innerHTML = btn.dataset.origHtml || 'ล้าง';
                btn.className = 'px-3 py-2.5 bg-neutral-800 hover:bg-neutral-700 active:scale-95 text-neutral-300 rounded-xl text-xs font-semibold cursor-pointer';
            }
        }, 3000);
        return;
    }

    if (clearGunConfirmTimer) clearTimeout(clearGunConfirmTimer);
    if (btn) {
        delete btn.dataset.confirming;
        btn.innerHTML = btn.dataset.origHtml || 'ล้าง';
        btn.className = 'px-3 py-2.5 bg-neutral-800 hover:bg-neutral-700 active:scale-95 text-neutral-300 rounded-xl text-xs font-semibold cursor-pointer';
    }

    continuousGunList = [];
    renderContinuousGunFeed();
    showToast('🧹 ล้างรายการสแกนเรียบร้อยแล้ว', 'success');

    // ปลุกกล้องให้ทำงานต่อเนื่องทันที
    wakeUpCameraIfPaused();
};

window.addContinuousGunToBatch = function() {
    if (continuousGunList.length === 0) {
        showToast('⚠️ ยังไม่มีรายการที่สแกน กรุณาส่องบาร์โค้ดก่อนครับ', 'warning');
        return;
    }

    let addedCount = 0;
    continuousGunList.slice().reverse().forEach(item => {
        if (!batchScanList.some(b => (typeof b === 'object' ? b.sn : b) === item.sn)) {
            const isSold = isAssetSold(item);
            batchScanList.push({
                sn: item.sn,
                model: item.model || '-',
                company: isSold ? (item.company && item.company !== '-' ? item.company : '(Stock Sell)') : (item.company || '-'),
                quotation: item.quotation || '-',
                status: isSold ? 'Sell' : (item.status || '-'),
                stock: isSold ? 'Stock Sell' : (item.stock || 'Stock Rent'),
                timestamp: new Date().toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
            });
            addedCount++;
        }
    });

    continuousGunList = [];
    renderContinuousGunFeed();
    updateBatchUI();
    showToast(`✅ นำเข้า S/N สำเร็จ ${addedCount} เครื่อง! (รวม ${batchScanList.length} เครื่อง)`, 'success');
    switchMainTab('batch');
};

window.transferContinuousToManualTextarea = function() {
    if (continuousGunList.length === 0) {
        switchScannerMode('manual');
        switchManualSubmode('bulk');
        return;
    }

    const ta = document.getElementById('bulk-manual-textarea');
    if (ta) {
        const existing = ta.value.trim();
        const snLines = continuousGunList.slice().reverse().map(i => i.sn).join('\n');
        ta.value = existing ? (existing + '\n' + snLines) : snLines;
    }
    switchScannerMode('manual');
    switchManualSubmode('bulk');
    handleBulkManualInput();
};

window.openCameraContinuousGun = function() {
    switchScannerMode('camera');
    switchCameraScanMode('continuous');
};

// -------------------------------------------------------------------------
// ⌨️ Bulk Gun Manual Entry Logic & Live Preview Feed (สไตล์รูปที่ 2)
// -------------------------------------------------------------------------
let bulkManualDebounceTimer = null;

window.handleBulkManualInput = function() {
    const ta = document.getElementById('bulk-manual-textarea');
    if (!ta) return;
    const rawVal = ta.value;
    const lines = rawVal.split(/[\r\n,]+/).map(l => {
        return l.replace(/^[Ss]\/[Nn][:\-\s]*/, '').replace(/^[Ss][Nn][:\-\s]*/, '').trim().toUpperCase();
    }).filter(s => s && s !== '-');

    const unique = [];
    lines.forEach(s => {
        if (!unique.includes(s)) unique.push(s);
    });

    if (unique.length > lastBulkManualCount) {
        playBeepSound();
    }
    lastBulkManualCount = unique.length;

    const btnCountEl = document.getElementById('bulk-btn-count');
    if (btnCountEl) btnCountEl.textContent = unique.length;

    renderBulkManualLivePreview(lines);
};

function renderBulkManualLivePreview(lines) {
    const summaryBar = document.getElementById('bulk-summary-bar');
    const previewBox = document.getElementById('bulk-live-preview-box');
    const cardsList = document.getElementById('bulk-live-cards-list');
    const statTotal = document.getElementById('bulk-stat-total');
    const statRent = document.getElementById('bulk-stat-rent');
    const statStock = document.getElementById('bulk-stat-stock');
    const statNotfound = document.getElementById('bulk-stat-notfound');
    const statDup = document.getElementById('bulk-stat-dup');
    const statDupWrapper = document.getElementById('bulk-stat-dup-wrapper');
    const loadingEl = document.getElementById('bulk-preview-loading');

    if (!lines || lines.length === 0) {
        if (summaryBar) summaryBar.classList.add('hidden');
        if (previewBox) previewBox.classList.add('hidden');
        if (cardsList) cardsList.innerHTML = '';
        return;
    }

    if (summaryBar) summaryBar.classList.remove('hidden');
    if (previewBox) previewBox.classList.remove('hidden');

    let rentCount = 0;
    let stockCount = 0;
    let notfoundCount = 0;
    let dupCount = 0;
    let seen = new Set();
    const uncachedToLookup = [];

    const cardsHtml = lines.map((sn, idx) => {
        const isDup = seen.has(sn);
        seen.add(sn);
        if (isDup) {
            dupCount++;
            const cachedItem = localSnDetailCache.get(sn) || { sn: sn };
            return createScannedItemCardHtml(cachedItem, idx + 1, true);
        }

        const cached = localSnDetailCache.get(sn);
        if (!cached) {
            uncachedToLookup.push(sn);
            return createScannedItemCardHtml({ sn: sn, loading: true }, idx + 1, false);
        }

        if (cached.notFound) {
            notfoundCount++;
        } else {
            const hasContract = (cached.company && cached.company !== '-' && cached.company.toLowerCase() !== 'null') ||
                                (cached.quotation && cached.quotation !== '-' && cached.quotation !== 'ไม่มี');
            if (hasContract) rentCount++;
            else stockCount++;
        }

        return createScannedItemCardHtml(cached, idx + 1, false);
    }).join('');

    if (cardsList) cardsList.innerHTML = cardsHtml;
    if (statTotal) statTotal.textContent = lines.length;
    if (statRent) statRent.textContent = rentCount;
    if (statStock) statStock.textContent = stockCount;
    if (statNotfound) statNotfound.textContent = notfoundCount;
    if (statDup) statDup.textContent = dupCount;
    if (statDupWrapper) {
        if (dupCount > 0) statDupWrapper.classList.remove('hidden');
        else statDupWrapper.classList.add('hidden');
    }

    if (uncachedToLookup.length > 0) {
        if (loadingEl) loadingEl.classList.remove('hidden');
        if (bulkManualDebounceTimer) clearTimeout(bulkManualDebounceTimer);
        bulkManualDebounceTimer = setTimeout(() => {
            lookupBatchSns(uncachedToLookup, () => {
                if (loadingEl) loadingEl.classList.add('hidden');
                // Re-render เมื่อได้ข้อมูลใหม่จากชีต
                const ta = document.getElementById('bulk-manual-textarea');
                if (ta) {
                    const currentLines = ta.value.split(/[\r\n,]+/).map(l => {
                        return l.replace(/^[Ss]\/[Nn][:\-\s]*/, '').replace(/^[Ss][Nn][:\-\s]*/, '').trim().toUpperCase();
                    }).filter(s => s && s !== '-');
                    renderBulkManualLivePreview(currentLines);
                }
            });
        }, 300);
    } else {
        if (loadingEl) loadingEl.classList.add('hidden');
    }
}

window.clearBulkManualTextarea = function() {
    const ta = document.getElementById('bulk-manual-textarea');
    if (ta) {
        ta.value = '';
        lastBulkManualCount = 0;
        handleBulkManualInput();
        ta.focus();
    }
};

window.addBulkManualToBatch = function() {
    const ta = document.getElementById('bulk-manual-textarea');
    if (!ta) return;
    const lines = ta.value.split(/[\r\n,]+/);
    const snList = [];
    lines.forEach(l => {
        let clean = l.replace(/^[Ss]\/[Nn][:\-\s]*/, '').replace(/^[Ss][Nn][:\-\s]*/, '').trim().toUpperCase();
        if (clean && clean !== '-' && !snList.includes(clean)) {
            snList.push(clean);
        }
    });

    if (snList.length === 0) {
        alert('กรุณายิงหรือระบุ S/N อย่างน้อย 1 เครื่องครับ');
        ta.focus();
        return;
    }

    let addedCount = 0;
    snList.forEach(sn => {
        if (!batchScanList.some(item => (typeof item === 'object' ? item.sn : item) === sn)) {
            const cached = localSnDetailCache.get(sn) || {};
            batchScanList.push({
                sn: sn,
                model: cached.model || '-',
                company: cached.company || cached.comp || '-',
                quotation: cached.quotation || cached.quote || '-',
                status: cached.status || 'Available',
                stock: cached.stock || cached.sheet || 'Stock Rent',
                timestamp: new Date().toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
            });
            addedCount++;
        }
    });

    ta.value = '';
    lastBulkManualCount = 0;
    handleBulkManualInput();

    updateBatchUI();
    switchMainTab('batch');
    alert(`นำเข้า S/N สำเร็จจำนวน ${addedCount} เครื่อง! (รวมในถาดสะสม ${batchScanList.length} เครื่อง)\n\nสามารถกดปุ่ม "📤 ส่งให้ Admin ตรวจสอบ" ได้ทันทีครับ`);
};

// =========================================================================
// 🔍 Device Lookup & Google Sheets API Connection
// =========================================================================
async function lookupDeviceBySn(sn) {
    if (!sn) return;

    // Show result tab immediately
    switchMainTab('result');

    // 1. Try local cache first (0.01s instant from 9,736 synced rows!)
    const localItem = await getCachedAssetBySn(sn);
    if (localItem) {
        renderAssetResultCard(localItem);

        // Background update quotation/latest info asynchronously without blocking UI
        if (apiUrl) {
            fetch(`${apiUrl}?action=lookupSn&sn=${encodeURIComponent(sn)}`)
                .then(r => r.json())
                .then(data => {
                    if (data && data.success && data.item) {
                        saveAssetToCache(data.item);
                        renderAssetResultCard(data.item);
                    }
                })
                .catch(() => {});
        }
        return; // ⚡ คืนค่าทันที ไม่ต้องรอคลาวด์โหลดหมื่นแถว
    }

    // 2. Not found in local cache: show loading and query live API with 3.5s timeout
    renderResultLoading(sn);

    if (apiUrl) {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 3500); // 3.5s timeout max

            const queryUrl = `${apiUrl}?action=lookupSn&sn=${encodeURIComponent(sn)}`;
            const response = await fetch(queryUrl, { signal: controller.signal });
            clearTimeout(timeoutId);
            const data = await response.json();

            if (data && data.success && data.item) {
                renderAssetResultCard(data.item);
                saveAssetToCache(data.item);
                return;
            } else if (data && data.message) {
                renderAssetNotFound(sn, data.message);
                return;
            }
        } catch(apiErr) {
            console.warn('API lookup error/timeout:', apiErr);
            renderAssetNotFound(sn, "ไม่พบข้อมูลเครื่องในชีต");
            return;
        }
    } else {
        renderApiUrlMissing(sn);
        return;
    }

    renderAssetNotFound(sn);
}

function renderResultLoading(sn) {
    const cardSn = document.getElementById('card-sn');
    const cardModel = document.getElementById('card-model');
    const cardComp = document.getElementById('card-comp');
    const cardPeriod = document.getElementById('card-period');

    if (cardSn) cardSn.textContent = sn;
    if (cardModel) cardModel.textContent = "กำลังค้นหาข้อมูลใน Google Sheets...";
    if (cardComp) cardComp.textContent = "⏳ กำลังดึงข้อมูล...";
    if (cardPeriod) cardPeriod.textContent = "-";
}

function renderAssetResultCard(item) {
    currentAssetItem = item;

    const sn = item.sn || '-';
    const model = item.model || 'ไม่ระบุชื่อรุ่น';
    const company = item.company || item.comp || '-';
    const quotation = item.quotation || item.quote || '-';
    const expire = item.dateExpire || item.expire || '-';
    const start = item.dateStart || item.start || '';
    const spec = item.spec || '-';
    const remark = item.remark || '-';
    const tag = item.tag || item.clientAssetTag || '-';
    const isSold = isAssetSold(item);
    if (isSold) {
        item.status = 'Sell';
        item.stock = 'Stock Sell';
    }
    const stock = isSold ? 'Stock Sell' : (item.stock || item.sheet || 'Google Sheets');

    document.getElementById('card-sn').textContent = sn;
    document.getElementById('card-model').textContent = model;
    document.getElementById('card-brand').textContent = detectBrand(model);
    
    // 🏢 เครื่องนี้อยู่ที่ไหน (สถานที่ / บริษัทลูกค้า / คลังสต็อก)
    const compEl = document.getElementById('card-comp');
    if (compEl) {
        if (isSold) {
            compEl.innerHTML = `<span class="font-bold text-rose-400">${company}</span> <span class="text-[10px] text-neutral-400">(Stock Sell)</span>`;
        } else if (company !== '-' && company !== '' && company.toLowerCase() !== 'null') {
            compEl.innerHTML = `<span class="font-bold text-emerald-400">${company}</span> <span class="text-[10px] text-neutral-400">(${stock})</span>`;
        } else {
            compEl.innerHTML = `<span class="text-neutral-300">อยู่ในคลัง (${stock})</span>`;
        }
    }

    document.getElementById('card-tag').textContent = tag;
    document.getElementById('card-quote').textContent = quotation;
    document.getElementById('card-spec').textContent = spec;
    document.getElementById('card-remark').textContent = remark;

    // Period & Days remaining
    const periodText = isSold ? '-' : ((start && expire && expire !== '-') ? `${start} - ${expire}` : expire);
    document.getElementById('card-period').textContent = periodText;

    const daysLeftEl = document.getElementById('card-days-left');
    if (isSold) {
        if (daysLeftEl) daysLeftEl.textContent = '';
    } else if (daysLeftEl && expire && expire !== '-') {
        const days = calculateDaysRemaining(expire);
        if (days !== null) {
            if (days > 0) {
                daysLeftEl.textContent = `เหลือสัญญาอีก ${days} วัน`;
                daysLeftEl.className = "text-[10px] text-emerald-400 font-bold mt-0.5";
            } else {
                daysLeftEl.textContent = `หมดสัญญาแล้ว (${Math.abs(days)} วัน)`;
                daysLeftEl.className = "text-[10px] text-rose-400 font-bold mt-0.5";
            }
        } else {
            daysLeftEl.textContent = '';
        }
    } else if (daysLeftEl) {
        daysLeftEl.textContent = '';
    }

    // Source badge
    const sourceBadge = document.getElementById('result-source-badge');
    if (sourceBadge) {
        if (isSold) {
            sourceBadge.textContent = 'Stock Sell';
            sourceBadge.className = 'px-2 py-0.5 rounded-md text-[10px] font-bold bg-rose-500/20 text-rose-400 border border-rose-500/30';
        } else {
            sourceBadge.textContent = stock;
            sourceBadge.className = 'px-2 py-0.5 rounded-md text-[10px] font-bold bg-neutral-800 text-neutral-400 border border-neutral-700';
        }
    }

    // Status badge styling (เครื่องที่ตัดขายแล้วให้แสดง Sell สีแดง/โรส ทันที ไม่ใช่ติดเช่า)
    const statusBadge = document.getElementById('card-status-badge');
    if (statusBadge) {
        let s = isSold ? 'Sell' : (item.status || 'พร้อมใช้งาน');
        statusBadge.textContent = s;
        if (isSold || s === 'Sell' || s.includes('Sold') || s.includes('ตัดขาย')) {
            statusBadge.className = "px-3 py-1 rounded-full text-xs font-black bg-rose-500/20 text-rose-400 border border-rose-500/40 shadow-xs";
        } else if (s.includes('กำลังใช้งาน') || s.includes('เช่า') || s.includes('Renting')) {
            statusBadge.className = "px-3 py-1 rounded-full text-xs font-bold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30";
        } else if (s.includes('สำรอง') || s.includes('Spare')) {
            statusBadge.className = "px-3 py-1 rounded-full text-xs font-bold bg-amber-500/20 text-amber-400 border border-amber-500/30";
        } else if (s.includes('ซ่อม') || s.includes('Repair')) {
            statusBadge.className = "px-3 py-1 rounded-full text-xs font-bold bg-rose-500/20 text-rose-400 border border-rose-500/30";
        } else {
            statusBadge.className = "px-3 py-1 rounded-full text-xs font-bold bg-blue-500/20 text-blue-400 border border-blue-500/30";
        }
    }

    // 🎯 คำนวณสรุปข้อมูล Quotation: Q อะไร และ ขาดกี่ตัว
    renderQuotationProgress(item);

    // 📑 แสดงเอกสารแนบ / ใบส่งของ PDF สำหรับ Quotation นี้
    renderQuotationDoc(item);
}

function renderQuotationProgress(item) {
    const qBox = document.getElementById('card-quotation-progress-box');
    if (!qBox) return;

    const qSum = item.quotationSummary;
    const quotation = item.quotation || item.quote;

    if (!qSum || !quotation || quotation === '-' || quotation === '') {
        qBox.classList.add('hidden');
        return;
    }

    qBox.classList.remove('hidden');

    const totalCount = qSum.totalCount || 0;
    const allSns = qSum.snList || [];

    // หาเครื่องที่สแกนแล้วในชุดสะสม + เครื่องปัจจุบัน
    const currentScannedSet = new Set(batchScanList.map(b => b.sn.toUpperCase()));
    if (item.sn) currentScannedSet.add(item.sn.toUpperCase());

    const scannedInQuote = allSns.filter(s => currentScannedSet.has(s.toUpperCase()));
    const missingInQuote = allSns.filter(s => !currentScannedSet.has(s.toUpperCase()));

    const scannedCount = scannedInQuote.length;
    const missingCount = missingInQuote.length;
    const pct = totalCount > 0 ? Math.min(100, Math.round((scannedCount / totalCount) * 100)) : 0;

    // อัปเดต UI
    const qNameEl = document.getElementById('card-q-name');
    if (qNameEl) qNameEl.textContent = qSum.quotation;

    const qBadgeEl = document.getElementById('card-q-progress-badge');
    if (qBadgeEl) {
        qBadgeEl.textContent = `${scannedCount} / ${totalCount} เครื่อง (${pct}%)`;
        if (missingCount === 0) {
            qBadgeEl.className = "px-2.5 py-1 rounded-full text-xs font-black bg-emerald-500/20 text-emerald-400 border border-emerald-500/40";
        } else {
            qBadgeEl.className = "px-2.5 py-1 rounded-full text-xs font-black bg-indigo-500/20 text-indigo-300 border border-indigo-500/40";
        }
    }

    const scannedCountEl = document.getElementById('card-q-scanned-count');
    if (scannedCountEl) scannedCountEl.textContent = scannedCount;

    const totalCountEl = document.getElementById('card-q-total-count');
    if (totalCountEl) totalCountEl.textContent = totalCount;

    const missingTextEl = document.getElementById('card-q-missing-text');
    if (missingTextEl) {
        if (missingCount === 0) {
            missingTextEl.textContent = "ครบทุกเครื่องแล้ว! 🎉";
            missingTextEl.className = "text-emerald-400 font-bold";
        } else {
            missingTextEl.textContent = `ขาดอีก ${missingCount} เครื่อง`;
            missingTextEl.className = "text-amber-400 font-bold";
        }
    }

    const progressBar = document.getElementById('card-q-progress-bar');
    if (progressBar) progressBar.style.width = `${pct}%`;

    const missingTag = document.getElementById('card-q-missing-tag');
    if (missingTag) {
        missingTag.textContent = missingCount === 0 ? "ครบถ้วน" : `ยังขาด ${missingCount} ตัว`;
        missingTag.className = missingCount === 0 ? "text-[10px] text-emerald-400 font-bold" : "text-[10px] text-rose-400 font-bold";
    }

    const missingChipsEl = document.getElementById('card-q-missing-chips');
    if (missingChipsEl) {
        if (missingCount === 0) {
            missingChipsEl.innerHTML = `
                <div class="w-full text-center py-2 text-emerald-400 text-xs font-semibold">
                    ✅ สแกนครบทั้ง ${totalCount} เครื่องในโครงการนี้เรียบร้อยแล้ว
                </div>
            `;
        } else {
            missingChipsEl.innerHTML = missingInQuote.map((sn, idx) => `
                <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-neutral-900 border border-neutral-700 text-rose-300 text-[11px] font-mono">
                    <span class="text-neutral-500 text-[9px]">#${idx+1}</span>
                    <span>${sn}</span>
                </span>
            `).join('');
        }
    }
}

function renderApiUrlMissing(sn) {
    document.getElementById('card-sn').textContent = sn;
    document.getElementById('card-model').textContent = "ยังไม่ได้เชื่อมต่อ Google Sheets";
    document.getElementById('card-brand').textContent = "GOOGLE APPS SCRIPT";
    document.getElementById('card-comp').textContent = "รอระบุ Web App URL";
    document.getElementById('card-spec').innerHTML = `
        <div class="p-3 bg-amber-500/10 border border-amber-500/30 rounded-2xl text-amber-300 space-y-2.5">
            <div class="flex items-center gap-2 font-bold text-sm">
                <span>⚠️</span> <span>ยังไม่ได้เชื่อมต่อ Google Sheets Web App URL</span>
            </div>
            <p class="text-[11px] text-neutral-300 leading-relaxed">
                กล้องสแกน S/N <b>${sn}</b> สำเร็จแล้ว 100% แต่แอพยังไม่มี URL สำหรับดึงข้อมูลจากระบบ Google Sheets
            </p>
            <div class="text-[11px] text-amber-200/90 bg-black/40 p-2.5 rounded-xl border border-amber-500/20 leading-relaxed">
                💡 <b>วิธีเชื่อมต่อ:</b> แตะที่แท็บ 2 ใน Safari เพื่อคัดลอก URL ของ Web App แล้วนำมากรอกในหน้า <b>"ตั้งค่า"</b> หรือส่ง URL ในแชท
            </div>
            <button type="button" onclick="switchMainTab('settings')" class="w-full py-2.5 bg-amber-500 hover:bg-amber-400 active:scale-98 text-black font-bold rounded-xl text-xs transition-all cursor-pointer flex items-center justify-center gap-1.5 shadow-md">
                <span>⚙️</span> <span>ไปที่หน้าตั้งค่า เพื่อใส่ Web App URL</span>
            </button>
        </div>
    `;
    document.getElementById('card-period').textContent = "-";
    document.getElementById('card-days-left').textContent = "";
    document.getElementById('card-quote').textContent = "-";
    document.getElementById('card-tag').textContent = "-";
    renderQuotationDoc(null);

    const statusBadge = document.getElementById('card-status-badge');
    if (statusBadge) {
        statusBadge.textContent = "ยังไม่เชื่อมต่อ";
        statusBadge.className = "px-3 py-1 rounded-full text-xs font-bold bg-amber-500/20 text-amber-400 border border-amber-500/30";
    }
}

function renderApiConnectionError(sn, err) {
    document.getElementById('card-sn').textContent = sn;
    document.getElementById('card-model').textContent = "เชื่อมต่อ Web App ไม่สำเร็จ";
    document.getElementById('card-brand').textContent = "CONNECTION ERROR";
    document.getElementById('card-comp').textContent = "ตรวจสอบสิทธิ์การเข้าถึงใน Apps Script";

    const isLoadFailed = err && String(err.message || err).includes('Load failed');
    const helpMsg = isLoadFailed
        ? `<div class="space-y-2 text-left">
            <div class="font-bold text-amber-300">💡 สาเหตุ: Google Apps Script ติดสิทธิ์ล็อกอิน (Google Login Redirect)</div>
            <div class="text-[11px] text-neutral-300 leading-relaxed bg-black/40 p-2.5 rounded-xl border border-neutral-700/60">
                <b>วิธีแก้ไขใน Google Apps Script Editor:</b><br>
                1. กดปุ่มสีน้ำเงิน <b>"ทำให้ใช้งานได้ (Deploy)"</b> บนขวา ➔ เลือก <b>"จัดการการทำให้ใช้งานได้ (Manage deployments)"</b><br>
                2. กดไอคอน ✏️ แก้ไข<br>
                3. เปลี่ยนช่อง <b>"ผู้มีสิทธิ์เข้าถึง (Who has access)"</b> เป็น 👉 <b>"ทุกคน (Anyone)"</b><br>
                4. ช่อง <b>"ดำเนินการในฐานะ (Execute as)"</b> ให้เลือกเป็น 👉 <b>"ฉัน (Me)"</b><br>
                5. กด <b>"ทำให้ใช้งานได้ (Deploy)"</b> เพื่อบันทึก
            </div>
           </div>`
        : `<p class="text-[11px] text-neutral-300 leading-relaxed">ไม่สามารถดึงข้อมูลได้: ${err && err.message ? err.message : 'Network error'}</p>`;

    document.getElementById('card-spec').innerHTML = `
        <div class="p-3.5 bg-rose-500/10 border border-rose-500/30 rounded-2xl text-rose-300 space-y-2.5">
            <div class="font-bold flex items-center gap-1.5 text-xs text-rose-400">
                <span>❌</span> <span>เกิดข้อผิดพลาดในการดึงข้อมูล (${err && err.message ? err.message : 'Error'})</span>
            </div>
            ${helpMsg}
            <button type="button" onclick="lookupDeviceBySn('${sn}')" class="w-full py-2.5 bg-neutral-800 hover:bg-neutral-700 active:scale-98 text-white rounded-xl text-xs font-bold transition-all cursor-pointer flex items-center justify-center gap-1.5 shadow-md">
                <span>🔄</span> <span>ลองใหม่อีกครั้ง</span>
            </button>
        </div>
    `;
    document.getElementById('card-period').textContent = "-";
    document.getElementById('card-days-left').textContent = "";
    document.getElementById('card-quote').textContent = "-";
    document.getElementById('card-tag').textContent = "-";
    renderQuotationDoc(null);

    const statusBadge = document.getElementById('card-status-badge');
    if (statusBadge) {
        statusBadge.textContent = "เชื่อมต่อล้มเหลว";
        statusBadge.className = "px-3 py-1 rounded-full text-xs font-bold bg-rose-500/20 text-rose-400 border border-rose-500/30";
    }
}

function renderAssetNotFound(sn, customMessage) {
    document.getElementById('card-sn').textContent = sn;
    document.getElementById('card-model').textContent = "ไม่พบข้อมูลเครื่องในชีต";
    document.getElementById('card-brand').textContent = "NEW / UNKNOWN";
    document.getElementById('card-comp').textContent = "ยังไม่มีประวัติในระบบ";
    document.getElementById('card-spec').textContent = customMessage || "ไม่พบประวัติ S/N นี้ในชีต Stock Rent / Stock New";
    document.getElementById('card-period').textContent = "-";
    document.getElementById('card-days-left').textContent = "";
    document.getElementById('card-quote').textContent = "-";
    document.getElementById('card-tag').textContent = "-";
    renderQuotationDoc(null);

    const statusBadge = document.getElementById('card-status-badge');
    if (statusBadge) {
        statusBadge.textContent = "ไม่พบในระบบ";
        statusBadge.className = "px-3 py-1 rounded-full text-xs font-bold bg-neutral-800 text-neutral-400 border border-neutral-700";
    }
}

function detectBrand(model) {
    if (!model) return 'NOTEBOOK / PC';
    const m = String(model).toUpperCase();
    if (m.includes('DELL')) return 'DELL';
    if (m.includes('HP') || m.includes('PROBOOK') || m.includes('ELITEBOOK')) return 'HP';
    if (m.includes('LENOVO') || m.includes('THINKPAD')) return 'LENOVO';
    if (m.includes('APPLE') || m.includes('MACBOOK')) return 'APPLE';
    if (m.includes('ACER')) return 'ACER';
    if (m.includes('ASUS')) return 'ASUS';
    return 'NOTEBOOK';
}

function calculateDaysRemaining(dateStr) {
    if (!dateStr || dateStr === '-') return null;
    try {
        const parts = dateStr.split('/');
        if (parts.length === 3) {
            const expDate = new Date(parseInt(parts[2]), parseInt(parts[1]) - 1, parseInt(parts[0]));
            const now = new Date();
            const diffTime = expDate - now;
            return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
        }
    } catch(e) {}
    return null;
}

window.copyCardSn = function() {
    const sn = document.getElementById('card-sn').textContent;
    if (sn && sn !== '-') {
        navigator.clipboard.writeText(sn).then(() => {
            const btnText = document.getElementById('copy-btn-text');
            if (btnText) {
                btnText.textContent = 'คัดลอกแล้ว! ✅';
                setTimeout(() => btnText.textContent = 'คัดลอก', 1500);
            }
        });
    }
};

// =========================================================================
// 📦 Multi-Scan Batch Mode
// =========================================================================
window.addToBatchList = function() {
    if (!currentAssetItem || !currentAssetItem.sn) return;
    const isExist = batchScanList.some(item => item.sn === currentAssetItem.sn);
    if (!isExist) {
        batchScanList.unshift(currentAssetItem);
        updateBatchUI();
    }
    switchMainTab('batch');
};

function updateBatchUI() {
    const countEl = document.getElementById('batch-count');
    const badgeEl = document.getElementById('nav-batch-badge');
    const listEl = document.getElementById('batch-list');

    if (countEl) countEl.textContent = batchScanList.length;
    if (badgeEl) {
        if (batchScanList.length > 0) {
            badgeEl.textContent = batchScanList.length;
            badgeEl.classList.remove('hidden');
        } else {
            badgeEl.classList.add('hidden');
        }
    }

    if (!listEl) return;
    if (batchScanList.length === 0) {
        listEl.innerHTML = `
            <div class="h-48 flex flex-col items-center justify-center text-neutral-500 text-xs gap-2">
                <span class="text-3xl">📦</span>
                <span>ยังไม่มีรายการในชุดนี้ สแกนแล้วกด "เพิ่มเข้าชุด"</span>
            </div>
        `;
        return;
    }

    listEl.innerHTML = batchScanList.map((item, idx) => {
        const itemStock = item.stock || 'Stock Rent';
        let stockStyle = 'text-emerald-400 bg-emerald-500/10 border-emerald-500/30';
        const stLower = itemStock.toLowerCase();
        if (stLower.includes('new')) stockStyle = 'text-cyan-400 bg-cyan-500/10 border-cyan-500/30';
        else if (stLower.includes('used')) stockStyle = 'text-pink-400 bg-pink-500/10 border-pink-500/30';
        else if (stLower.includes('sell') || stLower.includes('sold')) stockStyle = 'text-rose-400 bg-rose-500/10 border-rose-500/30';

        return `
        <div class="bg-[#1c1c1e] p-3 rounded-2xl border border-neutral-800 flex items-center justify-between shadow-sm">
            <div class="flex items-center gap-3">
                <span class="text-xs bg-blue-500/20 text-blue-400 font-bold px-2 py-0.5 rounded-lg font-mono">
                    #${batchScanList.length - idx}
                </span>
                <div>
                    <div class="flex items-center gap-1.5 flex-wrap">
                        <span class="font-mono font-bold text-sm text-white tracking-wider">${escapeHtml(item.sn)}</span>
                        <span class="text-[10px] font-bold px-1.5 py-0.5 rounded-md border ${stockStyle}">${escapeHtml(itemStock)}</span>
                    </div>
                    <div class="text-[11px] text-neutral-400 truncate max-w-[200px]">${escapeHtml(item.model || '-')}</div>
                </div>
            </div>
            <button type="button" onclick="removeBatchItem('${item.sn}')" class="text-rose-400 hover:text-rose-300 text-xs p-1.5 rounded-lg hover:bg-rose-500/20">
                ✕
            </button>
        </div>`;
    }).join('');
}

window.removeBatchItem = function(sn) {
    batchScanList = batchScanList.filter(i => i.sn !== sn);
    updateBatchUI();
};

window.clearBatchList = function() {
    if (confirm('ต้องการล้างรายการในชุดทั้งหมดหรือไม่?')) {
        batchScanList = [];
        updateBatchUI();
    }
};

window.copyAllBatchSns = function() {
    if (batchScanList.length === 0) return;
    const text = batchScanList.map(i => i.sn).join('\n');
    navigator.clipboard.writeText(text).then(() => {
        alert(`คัดลอก S/N ทั้งหมด ${batchScanList.length} เครื่องแล้ว!`);
    });
};

// 🧠 ตรวจสอบว่าสเปกของเครื่องต่ำกว่า Intel Gen 11 หรือไม่ (ต่ำกว่า Gen 11 = Stock Used, Gen 11 ขึ้นไป = Stock Rent)
function isSpecLowerThanGen11(modelStr, specStr) {
    if (!modelStr && !specStr) return false;
    const m = String(modelStr || '').trim();
    const s = String(specStr || '').trim();
    const combined = (m + ' ' + s).toLowerCase();

    // 1. ตรวจสอบชัดเจนว่ามี Gen 11 หรือสูงกว่าหรือไม่
    if (/\b(?:core\s*)?ultra\b/i.test(combined)) return false;
    if (/\b(?:core\s*)?i[3579][\s\-]*(?:1[1-9]\d{3})\b/i.test(combined)) return false;
    if (/\b(?:core\s*)?i[3579][\s\-]*(?:1[1-9]|20)(?:th)?[\s\-]*gen(?:eration)?\b/i.test(combined)) return false;
    if (/\bg(?:8|9|10|11)\b/i.test(m)) return false;
    if (/\bryzen[\s\-]*[3579][\s\-]*(?:[4-9]\d{3}|[1-9]\d{4})\b/i.test(combined)) return false;

    // 2. ตรวจสอบเงื่อนไข Gen 1 ถึง Gen 10 หรือ HP G1-G7
    if (/\b(?:core\s*)?i[3579][\s\-]*(?:[2-9]\d{3}|10\d{2,3})[a-z\d]*\b/i.test(combined)) return true;
    if (/\b(?:core\s*)?i[3579][\s\-]*(?:gen|generation)[\s\-]*(?:[1-9]|10)\b|\bi[3579][\s\-]*(?:[1-9]|10)(?:th)?[\s\-]*gen(?:eration)?\b/i.test(combined)) return true;
    if (/\bg[1-7]\b/i.test(m)) return true;
    if (/\bryzen[\s\-]*[3579][\s\-]*(?:[123]\d{3})[a-z\d]*\b/i.test(combined)) return true;

    return false;
}

// 📤 ส่งรายการสะสมให้ Admin ตรวจสอบ & อนุมัติ
window.openSubmitPendingModal = function() {
    if (!batchScanList || batchScanList.length === 0) {
        alert('ยังไม่มีรายการในถาดสะสม กรุณาสแกน S/N ก่อนส่งให้ Admin ครับ');
        return;
    }

    const modal = document.getElementById('modal-submit-pending');
    if (!modal) return;

    // Pre-fill sender name from localStorage
    const savedSender = localStorage.getItem('wkt_sender_name') || '';
    const senderInput = document.getElementById('pending-sender-name');
    if (senderInput) senderInput.value = savedSender;

    // Pre-fill model if first item has a model
    const modelInput = document.getElementById('pending-model-name');
    var foundModel = '';
    var foundSpec = '';
    if (batchScanList[0]) {
        foundModel = batchScanList[0].model || '';
        foundSpec = batchScanList[0].spec || '';
    }
    if (modelInput && foundModel && foundModel !== '-') {
        modelInput.value = foundModel;
    }

    // Auto-select target stock based on model/spec: lower than Gen 11 -> Stock Used, else -> Stock Rent
    const stockSelect = document.getElementById('pending-target-stock');
    if (stockSelect) {
        const isLower = isSpecLowerThanGen11(foundModel, foundSpec);
        stockSelect.value = isLower ? 'Stock Used' : 'Stock Rent';
    }

    // Populate chips
    const countEl = document.getElementById('pending-modal-count');
    if (countEl) countEl.textContent = `${batchScanList.length} เครื่อง`;

    const chipsEl = document.getElementById('pending-modal-sn-chips');
    if (chipsEl) {
        chipsEl.innerHTML = batchScanList.map((item, idx) => `
            <span class="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-neutral-900 border border-neutral-700 text-emerald-400">
                <span class="text-neutral-500 text-[9px]">#${idx+1}</span>
                <span>${item.sn}</span>
            </span>
        `).join('');
    }

    modal.classList.remove('hidden');
};


window.closeSubmitPendingModal = function() {
    const modal = document.getElementById('modal-submit-pending');
    if (modal) modal.classList.add('hidden');
};

// =========================================================================
// 📑 ระบบเปิดดูไฟล์ PDF / ใบส่งของเซ็นรับ (In-App PDF Viewer)
// =========================================================================
let currentQuotationDoc = null;

async function renderQuotationDoc(item) {
    const pillBtn = document.getElementById('card-quote-doc-pill');
    const docCard = document.getElementById('card-delivery-doc-card');
    const docNameEl = document.getElementById('card-delivery-doc-name');

    currentQuotationDoc = null;

    if (!item) {
        if (pillBtn) pillBtn.classList.add('hidden');
        if (docCard) docCard.classList.add('hidden');
        return;
    }

    const quotation = (item.quotation || item.quote || '').trim();

    // 1. กรณี item มี deliveryDoc อยู่แล้ว (จากเซิร์ฟเวอร์หรือแคช IndexedDB)
    if (item.deliveryDoc && (item.deliveryDoc.previewUrl || item.deliveryDoc.fileId || item.deliveryDoc.fileUrl)) {
        currentQuotationDoc = item.deliveryDoc;
        if (pillBtn) pillBtn.classList.remove('hidden');
        if (docCard) {
            docCard.classList.remove('hidden');
            if (docNameEl) docNameEl.textContent = item.deliveryDoc.fileName || `ใบส่งของ ${quotation}.pdf`;
        }
        return;
    }

    // 2. ถ้าไม่มี Quotation หรือเป็น "-" ให้ซ่อน
    if (!quotation || quotation === '-' || quotation === 'null') {
        if (pillBtn) pillBtn.classList.add('hidden');
        if (docCard) docCard.classList.add('hidden');
        return;
    }

    // 3. มีเลข Quotation ให้แสดงปุ่ม pill และดึงข้อมูลเอกสาร PDF ในแบ็คกราวด์
    if (pillBtn) pillBtn.classList.remove('hidden');

    if (apiUrl) {
        try {
            const docUrl = `${apiUrl}?action=getDeliveryDoc&quotation=${encodeURIComponent(quotation)}`;
            fetch(docUrl)
                .then(r => r.json())
                .then(res => {
                    if (res && res.success && res.found && res.doc) {
                        // ตรวจสอบว่าผู้ใช้ยังดูเครื่องเดิมอยู่หรือไม่
                        if (currentAssetItem && (currentAssetItem.quotation === quotation || currentAssetItem.quote === quotation)) {
                            currentQuotationDoc = res.doc;
                            currentAssetItem.deliveryDoc = res.doc;
                            try { saveAssetToCache(currentAssetItem); } catch(eCache) {}

                            if (pillBtn) pillBtn.classList.remove('hidden');
                            if (docCard) {
                                docCard.classList.remove('hidden');
                                if (docNameEl) docNameEl.textContent = res.doc.fileName || `ใบส่งของ ${quotation}.pdf`;
                            }
                        }
                    } else {
                        // ไม่พบเอกสารแนบ ให้ซ่อนการ์ดใบส่งของ
                        if (docCard) docCard.classList.add('hidden');
                    }
                })
                .catch(() => {});
        } catch (e) {}
    }
}

/* ==========================================================================
   📑 PDF Viewer Engine (PDF.js Canvas + Unified 1-Finger Scroll & 2-Finger Pinch Zoom)
   เรนเดอร์ PDF หน้าต่อหน้าบน HTML5 Canvas เพื่อให้เลื่อนดูเอกสาร (1 นิ้ว)
   และซูมขยาย (2 นิ้ว / ดับเบิ้ลแท็บ) ทำงานพร้อมกันได้ในโหมดเดียวกันทันที ไม่ต้องสลับโหมด!
   ========================================================================== */
let pdfUnifiedScale = 1.0;
const PDF_MIN_SCALE = 1.0;
const PDF_MAX_SCALE = 4.0;
let isPdfGesturesBound = false;
let currentPdfRenderToken = 0;
let pdfHintTimer = null;

// Gestures: 2-finger pinch state
let isPinchingPdf = false;
let pinchStartDistance = 0;
let pinchStartScale = 1.0;

// Tap detection: double-tap to zoom / reset
let lastPdfTapTime = 0;
let lastPdfTapX = 0;
let lastPdfTapY = 0;

function showPdfHint(text) {
    const hint = document.getElementById('pdf-gesture-hint');
    if (!hint) return;
    if (text) {
        const span = hint.querySelector('span:last-child') || hint;
        span.textContent = text;
    }
    hint.classList.remove('opacity-0', 'pointer-events-none');
    hint.classList.add('opacity-100');
    if (pdfHintTimer) clearTimeout(pdfHintTimer);
    pdfHintTimer = setTimeout(() => hidePdfHint(), 3500);
}

function hidePdfHint() {
    const hint = document.getElementById('pdf-gesture-hint');
    if (!hint) return;
    hint.classList.add('opacity-0', 'pointer-events-none');
    hint.classList.remove('opacity-100');
    if (pdfHintTimer) {
        clearTimeout(pdfHintTimer);
        pdfHintTimer = null;
    }
}

// 🎯 ปรับขนาดซูม (Unified Zoom) - ขยาย Stage กว้างขึ้นเพื่อให้ Scroll Container เลื่อนได้ทุกทิศทางด้วย 1 นิ้วตามธรรมชาติ
window.applyUnifiedPdfZoom = function(targetScale, animated = true) {
    pdfUnifiedScale = Math.round(Math.min(Math.max(targetScale, PDF_MIN_SCALE), PDF_MAX_SCALE) * 100) / 100;

    const container = document.getElementById('pdf-scroll-container');
    const stage = document.getElementById('pdf-pages-stage');
    const iframeStage = document.getElementById('pdf-iframe-stage');
    const badge = document.getElementById('pdf-zoom-percent-badge');

    const pct = Math.round(pdfUnifiedScale * 100);
    if (badge) {
        badge.textContent = `${pct}%`;
        if (pct !== 100) {
            badge.className = 'px-2.5 h-8 rounded-xl bg-indigo-600/30 text-indigo-300 font-mono font-bold text-xs flex items-center justify-center border border-indigo-500/40 shadow-xs transition-all cursor-pointer';
        } else {
            badge.className = 'px-2.5 h-8 rounded-xl bg-neutral-800/90 text-indigo-400 font-mono font-bold text-xs flex items-center justify-center transition-all cursor-pointer';
        }
    }

    if (container && stage) {
        // คำนวณความกว้างพื้นฐานให้พอดีหน้าจอ container
        const containerW = container.clientWidth > 0 ? container.clientWidth - 24 : window.innerWidth - 24;
        const baseW = Math.max(containerW, 280);
        const targetW = Math.round(baseW * pdfUnifiedScale);

        if (animated) {
            stage.style.transition = 'width 0.22s cubic-bezier(0.2, 0.9, 0.4, 1)';
        } else {
            stage.style.transition = 'none';
        }

        stage.style.width = `${targetW}px`;
        stage.style.minWidth = `${targetW}px`;
        stage.style.maxWidth = `${targetW}px`;
    }

    // กรณีสำรองที่เปิดผ่าน iframe ให้ซูม iframe ได้ด้วย
    if (iframeStage) {
        if (animated) {
            iframeStage.style.transition = 'transform 0.22s cubic-bezier(0.2, 0.9, 0.4, 1)';
        } else {
            iframeStage.style.transition = 'none';
        }
        iframeStage.style.transform = `scale(${pdfUnifiedScale})`;
        iframeStage.style.width = `${100 * pdfUnifiedScale}%`;
        iframeStage.style.height = `${100 * pdfUnifiedScale}%`;
    }
};

window.zoomUnifiedPdf = function(delta) {
    applyUnifiedPdfZoom(pdfUnifiedScale + delta, true);
};

window.resetUnifiedPdfZoom = function() {
    const container = document.getElementById('pdf-scroll-container');
    applyUnifiedPdfZoom(1.0, true);
    if (container) {
        container.scrollTo({ top: 0, left: 0, behavior: 'smooth' });
    }
};

// Backward-compatible aliases
window.zoomQuotationPdf = function(delta) { window.zoomUnifiedPdf(delta); };
window.resetQuotationPdfZoom = function() { window.resetUnifiedPdfZoom(); };
window.togglePdfTouchMode = function() {}; // No-op: ไม่ต้องสลับโหมดอีกต่อไป

// Double-tap handler: 1.0x <-> 2.2x
function handlePdfDoubleTap(clientX, clientY) {
    if (pdfUnifiedScale > 1.3) {
        window.resetUnifiedPdfZoom();
    } else {
        window.applyUnifiedPdfZoom(2.2, true);
    }
}

// 🖐️ Unified Gesture Handler: 1 นิ้วเลื่อนอ่านได้อย่างอิสระ 60fps / 2 นิ้วกางหุบซูมได้ในโหมดเดียวกันทันที
function initUnifiedPdfGestures() {
    const container = document.getElementById('pdf-scroll-container');
    if (!container || isPdfGesturesBound) return;
    isPdfGesturesBound = true;

    // 1. iOS Safari Hardware Pinch Events (iPhone / iPad)
    container.addEventListener('gesturestart', (e) => {
        e.preventDefault();
        hidePdfHint();
        isPinchingPdf = true;
        pinchStartScale = pdfUnifiedScale;
    }, { passive: false });

    container.addEventListener('gesturechange', (e) => {
        e.preventDefault();
        if (isPinchingPdf) {
            const newScale = Math.min(Math.max(pinchStartScale * e.scale, PDF_MIN_SCALE), PDF_MAX_SCALE);
            applyUnifiedPdfZoom(newScale, false);
        }
    }, { passive: false });

    container.addEventListener('gestureend', (e) => {
        e.preventDefault();
        isPinchingPdf = false;
        let finalScale = Math.min(Math.max(pdfUnifiedScale, PDF_MIN_SCALE), PDF_MAX_SCALE);
        if (finalScale < 1.05) finalScale = 1.0;
        applyUnifiedPdfZoom(finalScale, true);
    }, { passive: false });

    // 2. Standard Touch Events (Android Chrome, Desktop Touch, Cross-browser)
    container.addEventListener('touchstart', (e) => {
        hidePdfHint();

        if (e.touches.length === 1) {
            // 1 นิ้ว: ปล่อยให้ Native Browser Momentum Scrolling ทำงานเต็มประสิทธิภาพ (ไม่ preventDefault)
            const t = e.touches[0];
            const now = Date.now();
            const dist = Math.hypot(t.clientX - lastPdfTapX, t.clientY - lastPdfTapY);

            if (now - lastPdfTapTime < 320 && dist < 35) {
                e.preventDefault();
                lastPdfTapTime = 0;
                handlePdfDoubleTap(t.clientX, t.clientY);
                return;
            }
            lastPdfTapTime = now;
            lastPdfTapX = t.clientX;
            lastPdfTapY = t.clientY;
        } else if (e.touches.length === 2) {
            // 2 นิ้ว: Pinch-to-zoom แบบเรียลไทม์
            e.preventDefault();
            isPinchingPdf = true;
            const t1 = e.touches[0];
            const t2 = e.touches[1];
            pinchStartDistance = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
            pinchStartScale = pdfUnifiedScale;
        }
    }, { passive: false });

    window.addEventListener('touchmove', (e) => {
        if (isPinchingPdf && e.touches.length === 2) {
            e.preventDefault();
            const t1 = e.touches[0];
            const t2 = e.touches[1];
            const dist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
            if (pinchStartDistance <= 0) return;

            const factor = dist / pinchStartDistance;
            const newScale = Math.min(Math.max(pinchStartScale * factor, 0.85), PDF_MAX_SCALE * 1.15);
            applyUnifiedPdfZoom(newScale, false);
        }
        // เมื่อเป็น 1 นิ้ว ปล่อยให้เลื่อนหน้าจอตามปกติ ไม่ขัดจังหวะ momentum scroll
    }, { passive: false });

    const endTouch = (e) => {
        if (isPinchingPdf && e.touches.length < 2) {
            isPinchingPdf = false;
            let finalScale = Math.min(Math.max(pdfUnifiedScale, PDF_MIN_SCALE), PDF_MAX_SCALE);
            if (finalScale < 1.05) finalScale = 1.0;
            applyUnifiedPdfZoom(finalScale, true);
        }
    };

    window.addEventListener('touchend', endTouch);
    window.addEventListener('touchcancel', endTouch);

    // Trackpad Pinch / Mouse Wheel with Ctrl (Mac / PC / iPad Trackpad)
    container.addEventListener('wheel', (e) => {
        if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            hidePdfHint();
            const factor = e.deltaY < 0 ? 1.08 : 0.92;
            applyUnifiedPdfZoom(pdfUnifiedScale * factor, false);
        }
    }, { passive: false });
}

// 📑 เรนเดอร์ PDF หน้าต่อหน้าด้วย PDF.js บน Canvas ระดับ 2x Retina (รองรับทั้ง Uint8Array, ArrayBuffer, base64)
async function renderPdfWithData(pdfData, fileName, fileSize) {
    if (!window.pdfjsLib) {
        throw new Error('PDF.js library not loaded');
    }
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'pdf.worker.min.js';

    let uint8Array;
    if (pdfData instanceof Uint8Array) {
        uint8Array = pdfData;
    } else if (pdfData instanceof ArrayBuffer) {
        uint8Array = new Uint8Array(pdfData);
    } else if (typeof pdfData === 'string') {
        let rawBase64 = pdfData;
        if (rawBase64.startsWith('data:')) {
            rawBase64 = rawBase64.split(',')[1];
        }
        const byteCharacters = atob(rawBase64);
        uint8Array = new Uint8Array(byteCharacters.length);
        for (let i = 0; i < byteCharacters.length; i++) {
            uint8Array[i] = byteCharacters.charCodeAt(i);
        }
    } else {
        throw new Error('Invalid PDF data format');
    }

    const myToken = ++currentPdfRenderToken;
    const loadingTask = window.pdfjsLib.getDocument({
        data: uint8Array,
        cMapUrl: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/cmaps/',
        cMapPacked: true
    });

    const pdfDoc = await loadingTask.promise;
    if (myToken !== currentPdfRenderToken) return;

    const numPages = pdfDoc.numPages;
    const stage = document.getElementById('pdf-pages-stage');
    const scrollContainer = document.getElementById('pdf-scroll-container');
    const iframeContainer = document.getElementById('pdf-iframe-container');
    const pageBadge = document.getElementById('pdf-page-count-badge');
    const filesizeEl = document.getElementById('pdf-modal-filesize');
    const loadingEl = document.getElementById('pdf-modal-loading');

    if (filesizeEl && fileSize) filesizeEl.textContent = `ขนาด: ${fileSize}`;
    if (pageBadge) pageBadge.textContent = `${numPages} หน้า`;

    if (scrollContainer) scrollContainer.classList.remove('hidden');
    if (iframeContainer) iframeContainer.classList.add('hidden');
    if (stage) stage.innerHTML = '';

    for (let pageNum = 1; pageNum <= numPages; pageNum++) {
        if (myToken !== currentPdfRenderToken) return;

        const page = await pdfDoc.getPage(pageNum);
        // Render at 2.2x scale for crystal clear Retina resolution
        const viewport = page.getViewport({ scale: 2.2 });

        const pageWrapper = document.createElement('div');
        pageWrapper.className = 'pdf-page-card w-full flex flex-col items-center bg-white shadow-2xl rounded-xl overflow-hidden border border-neutral-800 shrink-0';

        const canvas = document.createElement('canvas');
        canvas.className = 'pdf-canvas w-full h-auto block select-none';
        canvas.width = viewport.width;
        canvas.height = viewport.height;

        const ctx = canvas.getContext('2d');
        await page.render({
            canvasContext: ctx,
            viewport: viewport
        }).promise;

        if (myToken !== currentPdfRenderToken) return;
        pageWrapper.appendChild(canvas);

        if (numPages > 1) {
            const label = document.createElement('div');
            label.className = 'w-full py-1 bg-neutral-900 text-neutral-400 text-[10px] font-mono text-center border-t border-neutral-800';
            label.textContent = `— หน้า ${pageNum} จาก ${numPages} —`;
            pageWrapper.appendChild(label);
        }

        stage.appendChild(pageWrapper);
    }

    if (loadingEl) loadingEl.classList.add('hidden');
    applyUnifiedPdfZoom(1.0, false);
}

// 🌐 Fallback: กรณีไฟล์ใหญ่มากหรือดึงไม่สำเร็จ ให้ใช้ Google Drive preview iframe
function fallbackToIframe(previewUrl, driveUrl, fileName, fileSize) {
    const scrollContainer = document.getElementById('pdf-scroll-container');
    const iframeContainer = document.getElementById('pdf-iframe-container');
    const iframe = document.getElementById('pdf-modal-iframe');
    const loadingEl = document.getElementById('pdf-modal-loading');
    const pageBadge = document.getElementById('pdf-page-count-badge');
    const filesizeEl = document.getElementById('pdf-modal-filesize');

    if (filesizeEl && fileSize) filesizeEl.textContent = `ขนาด: ${fileSize}`;
    if (pageBadge) pageBadge.textContent = 'Drive Preview';

    if (scrollContainer) scrollContainer.classList.add('hidden');
    if (iframeContainer) iframeContainer.classList.remove('hidden');

    if (iframe) {
        iframe.onload = () => {
            if (loadingEl) loadingEl.classList.add('hidden');
        };
        iframe.src = previewUrl;
    }

    setTimeout(() => {
        if (loadingEl && !loadingEl.classList.contains('hidden')) {
            loadingEl.classList.add('hidden');
        }
    }, 5000);
}

window.openQuotationPdfModal = async function(customDoc) {
    const modal = document.getElementById('modal-pdf-viewer');
    if (!modal) return;

    initUnifiedPdfGestures();
    window.resetUnifiedPdfZoom();
    showPdfHint('🖐️ ใช้นิ้วเลื่อนดูทุกหน้า • กาง 2 นิ้วซูมขยายได้ทันที');

    const titleEl = document.getElementById('pdf-modal-title');
    const subEl = document.getElementById('pdf-modal-sub');
    const externalLink = document.getElementById('pdf-modal-external-link');
    const loadingEl = document.getElementById('pdf-modal-loading');
    const errorEl = document.getElementById('pdf-modal-error');
    const errorMsgEl = document.getElementById('pdf-modal-error-msg');
    const filesizeEl = document.getElementById('pdf-modal-filesize');
    const pageBadge = document.getElementById('pdf-page-count-badge');
    const iframe = document.getElementById('pdf-modal-iframe');

    let doc = customDoc || currentQuotationDoc || (currentAssetItem && currentAssetItem.deliveryDoc);
    const quotation = (currentAssetItem && (currentAssetItem.quotation || currentAssetItem.quote)) || '-';

    modal.classList.remove('hidden');
    document.body.style.overflow = 'hidden';

    if (loadingEl) loadingEl.classList.remove('hidden');
    if (errorEl) errorEl.classList.add('hidden');
    if (iframe) iframe.src = '';
    if (pageBadge) pageBadge.textContent = 'เอกสาร PDF';
    if (subEl) subEl.textContent = `Quotation: ${quotation}`;
    if (titleEl) titleEl.textContent = 'กำลังโหลดเอกสาร PDF...';
    if (filesizeEl) filesizeEl.textContent = '';

    // ถ้ายังไม่มี doc แต่มี quotation ให้ดึงสด getDeliveryDoc
    if (!doc && quotation && quotation !== '-') {
        if (apiUrl) {
            try {
                const r = await fetch(`${apiUrl}?action=getDeliveryDoc&quotation=${encodeURIComponent(quotation)}`);
                const res = await r.json();
                if (res && res.success && res.found && res.doc) {
                    doc = res.doc;
                    currentQuotationDoc = doc;
                    if (currentAssetItem) {
                        currentAssetItem.deliveryDoc = doc;
                        try { saveAssetToCache(currentAssetItem); } catch(e) {}
                    }
                }
            } catch(e) {
                console.warn('Fetch doc error:', e);
            }
        }
    }

    if (doc && (doc.previewUrl || doc.fileId || doc.fileUrl)) {
        let fileId = doc.fileId || '';
        if (!fileId && doc.fileUrl) {
            const m = doc.fileUrl.match(/\/d\/([a-zA-Z0-9_-]+)/);
            if (m) fileId = m[1];
        }

        const previewUrl = doc.previewUrl || (fileId ? `https://drive.google.com/file/d/${fileId}/preview` : doc.fileUrl);
        const driveUrl = doc.fileUrl || (fileId ? `https://drive.google.com/file/d/${fileId}/view` : previewUrl);
        const fileName = doc.fileName || `ใบส่งของ (${quotation})`;
        const fileSize = doc.fileSize || '';

        if (titleEl) titleEl.textContent = fileName;
        if (filesizeEl && fileSize) filesizeEl.textContent = `ขนาด: ${fileSize}`;
        if (externalLink) {
            externalLink.href = driveUrl;
            externalLink.classList.remove('hidden');
        }

        const cacheKey = fileId || quotation;

        // 1. ตรวจสอบ Offline IndexedDB Cache ก่อนเลย (Zero-latency offline)
        let cached = await getCachedPdf(cacheKey);
        if (cached && (cached.uint8Array || cached.base64)) {
            try {
                await renderPdfWithData(cached.uint8Array || cached.base64, cached.fileName || fileName, cached.fileSize || fileSize);
                return;
            } catch(renderErr) {
                console.warn('Cached PDF render error, trying network fetch:', renderErr);
            }
        }

        // 2. ⚡ ดึงตรงจาก Google Drive UserContent (Direct High-Speed Fetch - Bypass Apps Script OAuth!)
        if (fileId) {
            try {
                const directUrl = `https://drive.usercontent.google.com/download?id=${fileId}&export=download`;
                const directRes = await fetch(directUrl);
                if (directRes.ok) {
                    const buf = await directRes.arrayBuffer();
                    if (buf && buf.byteLength > 100) {
                        const uint8 = new Uint8Array(buf);
                        const calcSize = fileSize || `${(buf.byteLength / 1024).toFixed(1)} KB`;
                        try {
                            await setCachedPdf(cacheKey, {
                                uint8Array: uint8,
                                fileName: fileName,
                                fileSize: calcSize
                            });
                        } catch(eC) {}

                        await renderPdfWithData(uint8, fileName, calcSize);
                        return;
                    }
                }
            } catch(directErr) {
                console.warn('Direct PDF fetch error, trying backend:', directErr);
            }
        }

        // 3. ดึง getPdfBase64 จาก Apps Script Backend (กรณีไฟล์ต้องการสิทธิ์พิเศษ)
        if (apiUrl) {
            try {
                const fetchUrl = `${apiUrl}?action=getPdfBase64${fileId ? `&fileId=${encodeURIComponent(fileId)}` : `&quotation=${encodeURIComponent(quotation)}`}`;
                const b64Res = await fetch(fetchUrl);
                const b64Json = await b64Res.json();

                if (b64Json && b64Json.success && b64Json.base64) {
                    try {
                        await setCachedPdf(cacheKey, {
                            base64: b64Json.base64,
                            fileName: b64Json.fileName || fileName,
                            fileSize: b64Json.fileSize || fileSize
                        });
                    } catch(eCache) {}

                    await renderPdfWithData(b64Json.base64, b64Json.fileName || fileName, b64Json.fileSize || fileSize);
                    return;
                }
            } catch(fetchErr) {
                console.warn('getPdfBase64 fetch error, fallback to iframe:', fetchErr);
            }
        }

        // 4. Fallback ไป Google Drive preview iframe ถ้าเรนเดอร์ base64/direct ไม่สำเร็จ
        fallbackToIframe(previewUrl, driveUrl, fileName, fileSize);
    } else {
        if (loadingEl) loadingEl.classList.add('hidden');
        if (errorEl) errorEl.classList.remove('hidden');
        if (titleEl) titleEl.textContent = `ใบส่งของ (${quotation})`;
        if (filesizeEl) filesizeEl.textContent = 'ยังไม่มีไฟล์แนบ';
        if (externalLink) externalLink.classList.add('hidden');
        if (errorMsgEl) errorMsgEl.textContent = `ยังไม่มีไฟล์ใบส่งของสำหรับ Quotation: ${quotation} ใน Google Drive`;
    }
};

window.closeQuotationPdfModal = function() {
    const modal = document.getElementById('modal-pdf-viewer');
    if (modal) modal.classList.add('hidden');
    const iframe = document.getElementById('pdf-modal-iframe');
    if (iframe) iframe.src = '';
    const stage = document.getElementById('pdf-pages-stage');
    if (stage) stage.innerHTML = '';
    document.body.style.overflow = '';
    window.resetUnifiedPdfZoom();
    hidePdfHint();
};

// ปิด Modal เมื่อกดปุ่ม Escape
window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        closeQuotationPdfModal();
        closeSubmitPendingModal();
    }
});

window.confirmSubmitBatchToAdmin = async function() {
    if (!batchScanList || batchScanList.length === 0) {
        alert('ไม่มีรายการ S/N ในถาดสะสม');
        return;
    }

    const senderInput = document.getElementById('pending-sender-name');
    const sender = senderInput ? senderInput.value.trim() : '';
    if (!sender) {
        alert('กรุณาระบุชื่อผู้ส่ง / สตาฟฟ์ ด้วยครับ');
        if (senderInput) senderInput.focus();
        return;
    }
    localStorage.setItem('wkt_sender_name', sender);

    const batchType = document.getElementById('pending-batch-type')?.value || 'รับเข้าสต็อกใหม่';
    const targetStock = document.getElementById('pending-target-stock')?.value || 'Stock Rent';
    const model = document.getElementById('pending-model-name')?.value.trim() || '-';
    const remark = document.getElementById('pending-remark')?.value.trim() || '-';

    const btn = document.getElementById('btn-confirm-submit-pending');
    const originalBtnText = btn ? btn.innerHTML : '';
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = `<span>⏳</span> <span>กำลังส่งข้อมูลให้ Admin...</span>`;
    }

    try {
        const payload = {
            action: 'submitPendingBatch',
            sender: sender,
            batchType: batchType,
            targetStock: targetStock,
            targetStockExplicit: true,
            model: model,
            remark: remark,
            snList: batchScanList.map(item => item.sn)
        };

        if (!apiUrl) {
            alert('⚠️ ยังไม่ได้เชื่อมต่อ Google Apps Script Web App URL กรุณาระบุในหน้า "ตั้งค่า" ก่อนครับ');
            if (btn) { btn.disabled = false; btn.innerHTML = originalBtnText; }
            return;
        }

        const res = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify(payload)
        });

        const data = await res.json();
        if (data && data.success) {
            closeSubmitPendingModal();
            alert(`✅ ${data.message || 'ส่งข้อมูลให้ Admin เรียบร้อยแล้ว!'}\n\nรหัสคำขอ: ${data.batchId || ''}\nAdmin สามารถเปิดหน้าเว็บเพื่อกดอนุมัติได้ทันทีครับ`);
            if (confirm('ส่งข้อมูลเรียบร้อยแล้ว ต้องการล้างรายการในถาดสะสมหรือไม่?')) {
                batchScanList = [];
                updateBatchUI();
            }
        } else {
            alert(`❌ ส่งข้อมูลไม่สำเร็จ: ${data ? (data.error || data.message) : 'Server error'}`);
        }
    } catch(err) {
        console.error('Submit pending batch error:', err);
        alert(`❌ เกิดข้อผิดพลาดในการเชื่อมต่อ: ${err.message || err}\n\n(หากขึ้น Load failed ให้ตรวจสอบว่า Google Apps Script ตั้งค่า Who has access เป็น Anyone แล้วหรือยังครับ)`);
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = originalBtnText;
        }
    }
};

// =========================================================================
// 🗄️ IndexedDB Offline Storage (Zero Latency Caching)
// =========================================================================
function openDatabase() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(STORE_ASSETS)) {
                db.createObjectStore(STORE_ASSETS, { keyPath: 'sn' });
            }
            if (!db.objectStoreNames.contains(STORE_PDF_CACHE)) {
                db.createObjectStore(STORE_PDF_CACHE, { keyPath: 'id' });
            }
        };
        req.onsuccess = (e) => resolve(e.target.result);
        req.onerror = (e) => reject(e.target.error);
    });
}

async function getCachedPdf(id) {
    if (!id) return null;
    try {
        const db = await openDatabase();
        return new Promise((resolve) => {
            const tx = db.transaction(STORE_PDF_CACHE, 'readonly');
            const req = tx.objectStore(STORE_PDF_CACHE).get(id);
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => resolve(null);
        });
    } catch(e) {
        return null;
    }
}

async function setCachedPdf(id, data) {
    if (!id || !data) return;
    try {
        const db = await openDatabase();
        const tx = db.transaction(STORE_PDF_CACHE, 'readwrite');
        tx.objectStore(STORE_PDF_CACHE).put({ id, ...data, cachedAt: Date.now() });
    } catch(e) {}
}

async function saveAssetToCache(item) {
    if (!item || !item.sn) return;
    try {
        addSnToKnownCache(item.sn);
        const db = await openDatabase();
        const tx = db.transaction(STORE_ASSETS, 'readwrite');
        tx.objectStore(STORE_ASSETS).put(item);
    } catch(e) {}
}

async function getCachedAssetBySn(sn) {
    if (!sn) return null;
    const cleanSn = String(sn).trim().toUpperCase();

    // First, check if findSystemMatchingSn knows this S/N from offline cache
    const matchedSn = (typeof findSystemMatchingSn === 'function') ? findSystemMatchingSn(cleanSn) : null;
    const candidates = [cleanSn];
    if (matchedSn && !candidates.includes(matchedSn)) {
        candidates.unshift(matchedSn);
    }

    // 1. Strip common prefixes: S/N:, SN:, (S), SERVICE TAG:, ST:, etc.
    const noPrefix = cleanSn.replace(/^(?:\(S\)|S\/N|SN|SERVICE TAG|SERNO|ST|S)[\s:\-_]*/i, '');
    if (noPrefix && !candidates.includes(noPrefix)) candidates.push(noPrefix);

    // 2. Dell Express Service Code (ตัวเลข 10-11 หลัก แปลงเป็น 7-character Service Tag เช่น 37061331052 -> H0XCY24)
    if (/^[0-9]{10,11}$/.test(cleanSn)) {
        try {
            const converted = parseInt(cleanSn, 10).toString(36).toUpperCase();
            if (converted && converted.length === 7 && !candidates.includes(converted)) {
                candidates.push(converted);
            }
        } catch(e) {}
    }

    // 3. Lenovo 1S prefix variation
    if (/^1S[A-Z0-9]{6,20}$/.test(cleanSn)) {
        const without1S = cleanSn.substring(2);
        if (!candidates.includes(without1S)) candidates.push(without1S);
    } else if (/^[A-Z0-9]{6,20}$/.test(cleanSn)) {
        const with1S = '1S' + cleanSn;
        if (!candidates.includes(with1S)) candidates.push(with1S);
    }

    // 4. Strip dashes and spaces
    const noDash = cleanSn.replace(/[\s\-_]/g, '');
    if (noDash && !candidates.includes(noDash)) candidates.push(noDash);

    // 5. Dell 7-character Substring (ดึง 7 หลักตัดสัญลักษณ์หน้า-หลัง เช่น "🔍 BBBHPL3")
    if (cleanSn.length > 7) {
        const sub7End = cleanSn.substring(cleanSn.length - 7);
        if (!candidates.includes(sub7End)) candidates.push(sub7End);
        const sub7Start = cleanSn.substring(0, 7);
        if (!candidates.includes(sub7Start)) candidates.push(sub7Start);
        const sevenMatches = cleanSn.match(/[A-Z0-9]{7}/g);
        if (sevenMatches) {
            for (const sm of sevenMatches) {
                if (!candidates.includes(sm)) candidates.push(sm);
            }
        }
    }

    // 6. OCR Disambiguation Matrix (สลับตัวอักษรที่มักอ่านสับสนบนหน้าจอคอมฯ / ฉลาก)
    // B <-> 8, 1 <-> L <-> I, 2 <-> Z, 0 <-> O, 5 <-> S, 6 <-> G, 0 <-> D
    const confusionPairs = [
        ['8', 'B'], ['B', '8'],
        ['1', 'L'], ['L', '1'], ['I', 'L'], ['L', 'I'], ['1', 'I'], ['I', '1'],
        ['2', 'Z'], ['Z', '2'],
        ['0', 'O'], ['O', '0'],
        ['5', 'S'], ['S', '5'],
        ['6', 'G'], ['G', '6'],
        ['0', 'D'], ['D', '0']
    ];

    const baseCands = [...candidates];
    for (const base of baseCands) {
        if (base.length < 5 || base.length > 20) continue;
        for (const [fromC, toC] of confusionPairs) {
            if (base.includes(fromC)) {
                const replacedAll = base.split(fromC).join(toC);
                if (!candidates.includes(replacedAll)) candidates.push(replacedAll);

                // ทีละตำแหน่ง (single swap)
                for (let i = 0; i < base.length; i++) {
                    if (base[i] === fromC) {
                        const singleSwap = base.substring(0, i) + toC + base.substring(i + 1);
                        if (!candidates.includes(singleSwap)) candidates.push(singleSwap);
                    }
                }
            }
        }
    }

    try {
        const db = await openDatabase();
        return new Promise((resolve) => {
            const tx = db.transaction(STORE_ASSETS, 'readonly');
            const store = tx.objectStore(STORE_ASSETS);
            let checked = 0;
            let found = false;

            for (const cand of candidates) {
                const req = store.get(cand);
                req.onsuccess = () => {
                    if (found) return;
                    if (req.result) {
                        found = true;
                        const item = req.result;
                        if (isAssetSold(item)) {
                            item.status = 'Sell';
                            item.stock = 'Stock Sell';
                        }
                        resolve(item);
                    } else {
                        checked++;
                        if (checked === candidates.length) resolve(null);
                    }
                };
                req.onerror = () => {
                    if (found) return;
                    checked++;
                    if (checked === candidates.length) resolve(null);
                };
            }
        });
    } catch(e) {
        return null;
    }
}

// Background Full Sheet Data Sync
window.syncAllSheetData = async function(manual) {
    if (!apiUrl) {
        if (manual) alert('กรุณาระบุ URL ของ Google Apps Script ในหน้าตั้งค่าก่อนครับ');
        return;
    }

    const badge = document.getElementById('api-status-badge');
    if (badge) badge.innerHTML = '<span class="w-1.5 h-1.5 rounded-full bg-amber-400 animate-spin"></span><span>กำลังซิงค์ชีต...</span>';

    try {
        const res = await fetch(`${apiUrl}?action=getAssetData`);
        const data = await res.json();

        if (data && data.success) {
            const rows = (data.rows && Array.isArray(data.rows)) ? data.rows : [];
            if (rows.length > 0) {
                const db = await openDatabase();
                await new Promise((resolveTx, rejectTx) => {
                    const tx = db.transaction(STORE_ASSETS, 'readwrite');
                    const store = tx.objectStore(STORE_ASSETS);
                    rows.forEach(r => {
                        if (r && r.sn) {
                            if (isAssetSold(r)) {
                                r.status = 'Sell';
                                r.stock = 'Stock Sell';
                            }
                            store.put(r);
                            addSnToKnownCache(r.sn);
                        }
                    });
                    tx.oncomplete = () => resolveTx();
                    tx.onerror = (e) => rejectTx(e);
                });

                if (badge) badge.innerHTML = `<span class="w-1.5 h-1.5 rounded-full bg-emerald-500"></span><span class="text-emerald-400">ซิงค์แล้ว (${rows.length.toLocaleString()} เครื่อง)</span>`;
                const cacheText = document.getElementById('cache-status-text');
                if (cacheText) cacheText.textContent = `เก็บข้อมูล ${rows.length.toLocaleString()} เครื่องแล้ว`;

                if (manual) alert(`ซิงค์สำเร็จ! บันทึกข้อมูล ${rows.length.toLocaleString()} เครื่องลงเครื่องแล้ว ใช้งานออฟไลน์ได้ทันที`);
            } else {
                // โหมด Real-time Gateway (เชื่อมต่อออนไลน์ ค้นหาสดผ่านคลาวด์ ไม่ต้องโหลดหมื่นแถวลงเครื่อง)
                if (badge) badge.innerHTML = `<span class="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></span><span class="text-emerald-400">เชื่อมต่อระบบแล้ว (พร้อมสแกน)</span>`;
                const cacheText = document.getElementById('cache-status-text');
                if (cacheText) cacheText.textContent = `เชื่อมต่อระบบ Google Sheets แบบ Real-time Online (พร้อมสแกนสด)`;

                if (manual) alert(`✅ เชื่อมต่อ Google Sheets เรียบร้อยแล้ว พร้อมสแกนค้นหา S/N แบบ Real-time`);
            }
        } else {
            if (badge) badge.innerHTML = '<span class="w-1.5 h-1.5 rounded-full bg-rose-500"></span><span class="text-rose-400">ไม่สามารถเชื่อมต่อชีตได้</span>';
            if (manual) alert('❌ ไม่สามารถเชื่อมต่อกับ Google Apps Script: ' + (data && data.error ? data.error : 'กรุณาตรวจสอบ URL ในหน้าตั้งค่า'));
        }
    } catch(err) {
        if (badge) badge.innerHTML = '<span class="w-1.5 h-1.5 rounded-full bg-rose-500"></span><span class="text-rose-400">ออฟไลน์</span>';
    }
};

// =========================================================================
// ⚙️ Navigation & Settings
// =========================================================================
window.switchMainTab = function(tabName) {
    currentTab = tabName;

    // Toggle tab visibility
    const tabs = ['scanner', 'result', 'batch', 'settings'];
    tabs.forEach(t => {
        const el = document.getElementById(`tab-${t}`);
        const btn = document.getElementById(`nav-btn-${t}`);
        if (el) {
            if (t === tabName) {
                el.classList.remove('hidden');
            } else {
                el.classList.add('hidden');
            }
        }
        if (btn) {
            if (t === tabName) {
                btn.className = "flex flex-col items-center gap-1 text-blue-400 cursor-pointer transition-colors";
            } else {
                btn.className = "flex flex-col items-center gap-1 text-neutral-500 hover:text-neutral-300 cursor-pointer transition-colors";
            }
        }
    });

    // Control camera stream based on tab
    if (tabName === 'scanner' && scannerMode === 'camera') {
        lastScannedCode = '';
        lastScannedTime = 0;
        candidateOcrSn = null;
        candidateOcrCount = 0;
        if (!scannerStream) startLiveCamera();
    } else {
        stopLiveCamera();
    }
};

function updateApiStatusBadge() {
    const badge = document.getElementById('api-status-badge');
    if (!badge) return;
    if (apiUrl) {
        badge.innerHTML = '<span class="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></span><span class="text-emerald-400">เชื่อมต่อระบบแล้ว (พร้อมสแกน)</span>';
    } else {
        badge.innerHTML = '<span class="w-1.5 h-1.5 rounded-full bg-amber-500 animate-ping"></span><span class="text-amber-400 font-bold underline cursor-pointer" onclick="switchMainTab(\'settings\')">⚠️ ยังไม่เชื่อมต่อชีต (แตะตั้งค่า)</span>';
    }
}

window.saveApiUrlSetting = function() {
    const input = document.getElementById('setting-api-url');
    if (!input) return;
    const url = input.value.trim();
    if (!url) {
        alert('กรุณาระบุ URL');
        return;
    }

    localStorage.setItem(STORAGE_KEY_API_URL, url);
    apiUrl = url;
    updateApiStatusBadge();
    alert('บันทึกการตั้งค่าเรียบร้อย! ระบบกำลังเริ่มซิงค์ข้อมูลกับ Google Sheets...');
    syncAllSheetData(true);
};

// Recent Scans Helper
function loadRecentScans() {
    try {
        recentScansList = JSON.parse(localStorage.getItem('wkt_recent_scans') || '[]');
        renderRecentScans();
    } catch(e) {}
}

function saveRecentScan(sn) {
    if (!sn) return;
    recentScansList = [sn, ...recentScansList.filter(s => s !== sn)].slice(0, 12);
    try {
        localStorage.setItem('wkt_recent_scans', JSON.stringify(recentScansList));
    } catch(e) {}
    renderRecentScans();
}

function renderRecentScans() {
    const listEl = document.getElementById('recent-scans-list');
    if (!listEl) return;
    if (recentScansList.length === 0) {
        listEl.innerHTML = '<span class="text-neutral-600 text-xs italic">ยังไม่มีประวัติการค้นหา</span>';
        return;
    }

    listEl.innerHTML = recentScansList.map(sn => `
        <button type="button" onclick="lookupDeviceBySn('${sn}')" class="px-2.5 py-1 bg-neutral-800 hover:bg-neutral-700 active:scale-95 text-white rounded-lg text-xs font-mono border border-neutral-700/80 cursor-pointer transition-all">
            ${sn}
        </button>
    `).join('');
}
