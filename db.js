const DB_NAME = 'skanky_audio';
const STORE_NAME = 'files';
let db = null;

export async function initDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = e => {
      e.target.result.createObjectStore(STORE_NAME, { keyPath: 'filename' });
    };
    req.onsuccess = e => {
      db = e.target.result;
      resolve();
    };
    req.onerror = () => reject(req.error);
  });
}

export async function saveFile(filename, blob) {
  return txPut({ filename, blob });
}

export async function getFile(filename) {
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE_NAME, 'readonly')
      .objectStore(STORE_NAME).get(filename);
    req.onsuccess = () => resolve(req.result?.blob ?? null);
    req.onerror = () => reject(req.error);
  });
}

export async function deleteFile(filename) {
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE_NAME, 'readwrite')
      .objectStore(STORE_NAME).delete(filename);
    req.onsuccess = resolve;
    req.onerror = () => reject(req.error);
  });
}

export async function getAllFilenames() {
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE_NAME, 'readonly')
      .objectStore(STORE_NAME).getAllKeys();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txPut(record) {
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE_NAME, 'readwrite')
      .objectStore(STORE_NAME).put(record);
    req.onsuccess = resolve;
    req.onerror = () => reject(req.error);
  });
}
