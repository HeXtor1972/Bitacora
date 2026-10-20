import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { initializeFirestore, persistentLocalCache, terminate, clearIndexedDbPersistence, collection, addDoc, setDoc, getDocs, deleteDoc, doc, query, orderBy, onSnapshot } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = initializeFirestore(app, { localCache: persistentLocalCache() });

const MAX_PHOTOS = 3;
const MAX_PHOTO_CHARS = 250000;
const MAX_FILES = 3;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const CHUNK_CHARS = 700000;
const ALLOWED_EXT = ['pdf', 'doc', 'docx', 'txt'];
const MIME_BY_EXT = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  txt: 'text/plain'
};

const $ = (id) => document.getElementById(id);
const loginView = $('login-view');
const mainView = $('main-view');
const loginForm = $('login-form');
const loginEmail = $('login-email');
const loginPass = $('login-pass');
const loginError = $('login-error');
const loginBtn = $('login-btn');
const modeBtn = $('mode-btn');
const togglePass = $('toggle-pass');
const logoutBtn = $('logout-btn');
const subtitle = $('subtitle');
const feed = $('feed');
const noteInput = $('note-input');
const saveBtn = $('save-btn');
const photoBtn = $('photo-btn');
const photoInput = $('photo-input');
const attachBtn = $('attach-btn');
const fileInput = $('file-input');
const previewStrip = $('photo-preview-strip');
const fileStrip = $('file-preview-strip');
const toast = $('toast');

let currentUser = null;
let unsubscribe = null;
let pendingPhotos = [];
let pendingFiles = [];
let registerMode = false;
let uploading = false;

function showToast(msg) {
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2200);
}

function newId() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

function fmtSize(bytes) {
  if (bytes < 1024 * 1024) return Math.max(1, Math.round(bytes / 1024)) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function extOf(name) {
  const i = name.lastIndexOf('.');
  return i === -1 ? '' : name.slice(i + 1).toLowerCase();
}

function fmtDay(ts) {
  const d = new Date(ts);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Hoy';
  if (d.toDateString() === yesterday.toDateString()) return 'Ayer';
  return d.toLocaleDateString('es-CL', {
    day: 'numeric',
    month: 'long',
    year: d.getFullYear() !== today.getFullYear() ? 'numeric' : undefined
  });
}

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit' });
}

function readAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('No se pudo leer el archivo'));
    reader.readAsDataURL(file);
  });
}

function compressImage(file, maxSide = 1280, quality = 0.7) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
      const w = Math.round(img.width * scale);
      const h = Math.round(img.height * scale);
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      let q = quality;
      let out = canvas.toDataURL('image/jpeg', q);
      while (out.length > MAX_PHOTO_CHARS && q > 0.3) {
        q -= 0.1;
        out = canvas.toDataURL('image/jpeg', q);
      }
      resolve(out);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('No se pudo leer la imagen'));
    };
    img.src = url;
  });
}

async function deleteFileChunks(fileId) {
  const snap = await getDocs(collection(db, 'users', currentUser.uid, 'files', fileId, 'chunks'));
  for (const d of snap.docs) {
    await deleteDoc(d.ref);
  }
}

async function uploadFile(file) {
  const id = newId();
  const dataUrl = await readAsDataURL(file);
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const total = Math.ceil(base64.length / CHUNK_CHARS);
  try {
    for (let n = 0; n < total; n++) {
      const chunkId = String(n).padStart(4, '0');
      await setDoc(doc(db, 'users', currentUser.uid, 'files', id, 'chunks', chunkId), {
        n,
        data: base64.slice(n * CHUNK_CHARS, (n + 1) * CHUNK_CHARS)
      });
    }
  } catch (err) {
    try { await deleteFileChunks(id); } catch (e) { /* sin acción */ }
    throw err;
  }
  const ext = extOf(file.name);
  return {
    id,
    name: file.name,
    type: file.type || MIME_BY_EXT[ext] || 'application/octet-stream',
    size: file.size,
    chunks: total
  };
}

async function downloadFile(meta) {
  try {
    showToast('Descargando…');
    const q = query(collection(db, 'users', currentUser.uid, 'files', meta.id, 'chunks'), orderBy('n'));
    const snap = await getDocs(q);
    if (snap.size !== meta.chunks) throw new Error('Archivo incompleto');
    const base64 = snap.docs.map((d) => d.data().data).join('');
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const blob = new Blob([bytes], { type: meta.type || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = meta.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  } catch (err) {
    showToast('No se pudo descargar el archivo');
  }
}

function renderEntries(entries) {
  feed.innerHTML = '';
  if (entries.length === 0) {
    const empty = document.createElement('div');
    empty.id = 'empty-state';
    empty.innerHTML = '<div class="glyph">＋</div><p>Aún no hay apuntes.<br>Escribe algo, toma una foto o adjunta un archivo para empezar tu bitácora.</p>';
    feed.appendChild(empty);
    return;
  }
  let lastDay = null;
  for (const entry of entries) {
    const dayLabel = fmtDay(entry.timestamp);
    if (dayLabel !== lastDay) {
      const lbl = document.createElement('div');
      lbl.className = 'day-label';
      lbl.textContent = dayLabel;
      feed.appendChild(lbl);
      lastDay = dayLabel;
    }
    const card = document.createElement('div');
    card.className = 'entry';

    const time = document.createElement('span');
    time.className = 'entry-time';
    time.textContent = fmtTime(entry.timestamp);
    card.appendChild(time);

    if (entry.text) {
      const p = document.createElement('p');
      p.className = 'entry-text';
      p.textContent = entry.text;
      card.appendChild(p);
    }
    for (const src of entry.photos || []) {
      const img = document.createElement('img');
      img.className = 'entry-photo';
      img.src = src;
      img.alt = 'Foto del apunte';
      card.appendChild(img);
    }
    for (const meta of entry.files || []) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'entry-file';
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = '📎 ' + meta.name;
      const size = document.createElement('span');
      size.className = 'size';
      size.textContent = fmtSize(meta.size);
      btn.appendChild(name);
      btn.appendChild(size);
      btn.onclick = () => downloadFile(meta);
      card.appendChild(btn);
    }

    const del = document.createElement('button');
    del.className = 'entry-del';
    del.textContent = '✕';
    del.setAttribute('aria-label', 'Eliminar apunte');
    del.onclick = async () => {
      try {
        for (const meta of entry.files || []) {
          await deleteFileChunks(meta.id);
        }
        await deleteDoc(doc(db, 'users', currentUser.uid, 'entries', entry.id));
      } catch (err) {
        showToast('No se pudo eliminar');
      }
    };
    card.appendChild(del);
    feed.appendChild(card);
  }
}

function updatePreviewStrip() {
  previewStrip.innerHTML = '';
  pendingPhotos.forEach((src, idx) => {
    const img = document.createElement('img');
    img.src = src;
    img.alt = 'Foto pendiente. Toca para quitar';
    img.onclick = () => {
      pendingPhotos.splice(idx, 1);
      updatePreviewStrip();
      updateSaveState();
    };
    previewStrip.appendChild(img);
  });
}

function updateFileStrip() {
  fileStrip.innerHTML = '';
  pendingFiles.forEach((file, idx) => {
    const chip = document.createElement('div');
    chip.className = 'file-chip';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = '📎 ' + file.name;
    const size = document.createElement('span');
    size.className = 'size';
    size.textContent = fmtSize(file.size);
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.textContent = '✕';
    rm.setAttribute('aria-label', 'Quitar archivo');
    rm.onclick = () => {
      pendingFiles.splice(idx, 1);
      updateFileStrip();
      updateSaveState();
    };
    chip.appendChild(name);
    chip.appendChild(size);
    chip.appendChild(rm);
    fileStrip.appendChild(chip);
  });
}

function updateSaveState() {
  const hasContent = noteInput.value.trim().length > 0 || pendingPhotos.length > 0 || pendingFiles.length > 0;
  saveBtn.disabled = uploading || !hasContent;
}

function authErrorMessage(code) {
  switch (code) {
    case 'auth/invalid-credential':
    case 'auth/wrong-password':
    case 'auth/user-not-found':
      return 'Correo o contraseña incorrectos. Si no tienes cuenta, toca "Crear cuenta".';
    case 'auth/invalid-email':
      return 'El correo no tiene un formato válido.';
    case 'auth/too-many-requests':
      return 'Demasiados intentos. Espera unos minutos e inténtalo de nuevo.';
    case 'auth/network-request-failed':
      return 'Sin conexión. Revisa tu internet e inténtalo de nuevo.';
    case 'auth/email-already-in-use':
      return 'Ese correo ya tiene una cuenta. Inicia sesión.';
    case 'auth/weak-password':
      return 'La contraseña debe tener al menos 6 caracteres.';
    default:
      return 'No se pudo completar la acción. Inténtalo de nuevo.';
  }
}

function setMode(register) {
  registerMode = register;
  loginError.textContent = '';
  loginBtn.textContent = register ? 'Crear cuenta' : 'Entrar';
  modeBtn.textContent = register ? '¿Ya tienes cuenta? Inicia sesión' : '¿No tienes cuenta? Crear cuenta';
  loginPass.autocomplete = register ? 'new-password' : 'current-password';
}

modeBtn.addEventListener('click', () => setMode(!registerMode));

togglePass.addEventListener('click', () => {
  const show = loginPass.type === 'password';
  loginPass.type = show ? 'text' : 'password';
  togglePass.textContent = show ? 'Ocultar' : 'Ver';
  togglePass.setAttribute('aria-label', show ? 'Ocultar contraseña' : 'Mostrar contraseña');
});

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  loginError.textContent = '';
  loginBtn.disabled = true;
  try {
    const email = loginEmail.value.trim();
    if (registerMode) {
      await createUserWithEmailAndPassword(auth, email, loginPass.value);
    } else {
      await signInWithEmailAndPassword(auth, email, loginPass.value);
    }
    loginPass.value = '';
  } catch (err) {
    loginError.textContent = authErrorMessage(err.code);
  } finally {
    loginBtn.disabled = false;
  }
});

logoutBtn.addEventListener('click', async () => {
  logoutBtn.disabled = true;
  try {
    if (unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
    await signOut(auth);
    await terminate(db);
    await clearIndexedDbPersistence(db);
  } catch (err) {
    // si la limpieza falla, igual se recarga la página
  }
  location.replace(location.pathname);
});

noteInput.addEventListener('input', () => {
  noteInput.style.height = 'auto';
  noteInput.style.height = Math.min(noteInput.scrollHeight, 120) + 'px';
  updateSaveState();
});

photoBtn.addEventListener('click', () => photoInput.click());

photoInput.addEventListener('change', async () => {
  const files = Array.from(photoInput.files || []);
  photoInput.value = '';
  for (const file of files) {
    if (pendingPhotos.length >= MAX_PHOTOS) {
      showToast('Máximo ' + MAX_PHOTOS + ' fotos por apunte');
      break;
    }
    try {
      pendingPhotos.push(await compressImage(file));
    } catch (err) {
      showToast('No se pudo procesar una foto');
    }
  }
  updatePreviewStrip();
  updateSaveState();
});

attachBtn.addEventListener('click', () => fileInput.click());

fileInput.addEventListener('change', async () => {
  const files = Array.from(fileInput.files || []);
  fileInput.value = '';
  for (const file of files) {
    if (file.type.startsWith('image/')) {
      if (pendingPhotos.length >= MAX_PHOTOS) {
        showToast('Máximo ' + MAX_PHOTOS + ' imágenes por apunte');
        continue;
      }
      try {
        pendingPhotos.push(await compressImage(file));
      } catch (err) {
        showToast('No se pudo procesar la imagen');
      }
      continue;
    }
    if (!ALLOWED_EXT.includes(extOf(file.name))) {
      showToast('Tipo no permitido. Usa PDF, Word, TXT o imágenes');
      continue;
    }
    if (file.size > MAX_FILE_BYTES) {
      showToast(file.name + ' pesa ' + fmtSize(file.size) + '. Máximo ' + fmtSize(MAX_FILE_BYTES));
      continue;
    }
    if (pendingFiles.length >= MAX_FILES) {
      showToast('Máximo ' + MAX_FILES + ' archivos por apunte');
      break;
    }
    pendingFiles.push(file);
  }
  updatePreviewStrip();
  updateFileStrip();
  updateSaveState();
});

function resetComposer() {
  noteInput.value = '';
  noteInput.style.height = 'auto';
  pendingPhotos = [];
  pendingFiles = [];
  updatePreviewStrip();
  updateFileStrip();
  updateSaveState();
}

saveBtn.addEventListener('click', async () => {
  const text = noteInput.value.trim();
  if (!currentUser || uploading) return;
  if (!text && pendingPhotos.length === 0 && pendingFiles.length === 0) return;
  if (pendingFiles.length > 0 && !navigator.onLine) {
    showToast('Sin conexión. Los archivos necesitan internet');
    return;
  }
  uploading = true;
  saveBtn.disabled = true;
  photoBtn.disabled = true;
  attachBtn.disabled = true;
  const uploaded = [];
  try {
    for (let i = 0; i < pendingFiles.length; i++) {
      showToast('Subiendo archivo ' + (i + 1) + ' de ' + pendingFiles.length + '…');
      uploaded.push(await uploadFile(pendingFiles[i]));
    }
    const entry = {
      text,
      photos: pendingPhotos.slice(),
      files: uploaded,
      timestamp: Date.now()
    };
    addDoc(collection(db, 'users', currentUser.uid, 'entries'), entry)
      .catch(() => showToast('No se pudo guardar. Revisa tu conexión'));
    resetComposer();
    showToast('Guardado');
  } catch (err) {
    for (const meta of uploaded) {
      try { await deleteFileChunks(meta.id); } catch (e) { /* sin acción */ }
    }
    showToast('No se pudo subir el archivo. Inténtalo de nuevo');
  } finally {
    uploading = false;
    photoBtn.disabled = false;
    attachBtn.disabled = false;
    updateSaveState();
  }
});

onAuthStateChanged(auth, (user) => {
  currentUser = user;
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
  if (user) {
    loginView.hidden = true;
    mainView.hidden = false;
    logoutBtn.hidden = false;
    subtitle.textContent = user.email;
    const q = query(collection(db, 'users', user.uid, 'entries'), orderBy('timestamp', 'desc'));
    unsubscribe = onSnapshot(
      q,
      (snap) => renderEntries(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
      () => showToast('No se pudieron cargar los apuntes')
    );
  } else {
    mainView.hidden = true;
    loginView.hidden = false;
    logoutBtn.hidden = true;
    subtitle.textContent = 'Inicia sesión para ver tus apuntes';
    feed.innerHTML = '';
    loginEmail.value = '';
    loginPass.value = '';
    loginPass.type = 'password';
    togglePass.textContent = 'Ver';
    loginError.textContent = '';
    setMode(false);
    resetComposer();
  }
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}