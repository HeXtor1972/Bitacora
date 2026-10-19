import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { initializeFirestore, persistentLocalCache, collection, addDoc, deleteDoc, doc, query, orderBy, onSnapshot } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = initializeFirestore(app, { localCache: persistentLocalCache() });

const MAX_PHOTOS = 3;
const MAX_PHOTO_CHARS = 250000;

const $ = (id) => document.getElementById(id);
const loginView = $('login-view');
const mainView = $('main-view');
const loginForm = $('login-form');
const loginEmail = $('login-email');
const loginPass = $('login-pass');
const loginError = $('login-error');
const loginBtn = $('login-btn');
const logoutBtn = $('logout-btn');
const subtitle = $('subtitle');
const feed = $('feed');
const noteInput = $('note-input');
const saveBtn = $('save-btn');
const photoBtn = $('photo-btn');
const photoInput = $('photo-input');
const previewStrip = $('photo-preview-strip');
const toast = $('toast');

let currentUser = null;
let unsubscribe = null;
let pendingPhotos = [];

function showToast(msg) {
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2000);
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

function renderEntries(entries) {
  feed.innerHTML = '';
  if (entries.length === 0) {
    const empty = document.createElement('div');
    empty.id = 'empty-state';
    empty.innerHTML = '<div class="glyph">＋</div><p>Aún no hay apuntes.<br>Escribe algo o toma una foto para empezar tu bitácora.</p>';
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

    const del = document.createElement('button');
    del.className = 'entry-del';
    del.textContent = '✕';
    del.setAttribute('aria-label', 'Eliminar apunte');
    del.onclick = () => {
      deleteDoc(doc(db, 'users', currentUser.uid, 'entries', entry.id))
        .catch(() => showToast('No se pudo eliminar'));
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

function updateSaveState() {
  saveBtn.disabled = !(noteInput.value.trim().length > 0 || pendingPhotos.length > 0);
}

function authErrorMessage(code) {
  switch (code) {
    case 'auth/invalid-credential':
    case 'auth/wrong-password':
    case 'auth/user-not-found':
      return 'Correo o contraseña incorrectos.';
    case 'auth/invalid-email':
      return 'El correo no tiene un formato válido.';
    case 'auth/too-many-requests':
      return 'Demasiados intentos. Espera unos minutos e inténtalo de nuevo.';
    case 'auth/network-request-failed':
      return 'Sin conexión. Revisa tu internet e inténtalo de nuevo.';
    default:
      return 'No se pudo iniciar sesión. Inténtalo de nuevo.';
  }
}

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  loginError.textContent = '';
  loginBtn.disabled = true;
  try {
    await signInWithEmailAndPassword(auth, loginEmail.value.trim(), loginPass.value);
    loginPass.value = '';
  } catch (err) {
    loginError.textContent = authErrorMessage(err.code);
  } finally {
    loginBtn.disabled = false;
  }
});

logoutBtn.addEventListener('click', () => signOut(auth));

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

saveBtn.addEventListener('click', () => {
  const text = noteInput.value.trim();
  if (!currentUser || (!text && pendingPhotos.length === 0)) return;
  const entry = { text, photos: pendingPhotos.slice(), timestamp: Date.now() };
  addDoc(collection(db, 'users', currentUser.uid, 'entries'), entry)
    .catch(() => showToast('No se pudo guardar. Revisa tu conexión'));
  noteInput.value = '';
  noteInput.style.height = 'auto';
  pendingPhotos = [];
  updatePreviewStrip();
  updateSaveState();
  showToast('Guardado');
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
  }
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}