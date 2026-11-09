
// =====================================================
// AI POWER REMINDER - SERVICE WORKER V2.0
// Firebase Cloud Messaging + Cache
// =====================================================

// 1. Xử lý khi người dùng nhấn vào thông báo
// Đặt trước khi nạp Firebase Messaging SDK.

self.addEventListener("notificationclick", event => {
  event.notification.close();

  const targetUrl =
    event.notification.data?.url || "./";

  event.waitUntil(
    clients.matchAll({
      type: "window",
      includeUncontrolled: true
    }).then(windowClients => {
      for (const client of windowClients) {
        if ("focus" in client) {
          return client.focus();
        }
      }

      return clients.openWindow(targetUrl);
    })
  );
});


// 2. Nạp Firebase SDK tương thích với Service Worker

importScripts(
  "https://www.gstatic.com/firebasejs/10.12.5/firebase-app-compat.js"
);

importScripts(
  "https://www.gstatic.com/firebasejs/10.12.5/firebase-messaging-compat.js"
);


// 3. Khởi tạo Firebase
// Thay YOUR_FIREBASE_API_KEY bằng apiKey trong firebase-config.js.

firebase.initializeApp({
  apiKey: "AIzaSyD2PYSmJ4XW3R6ZoC1we8bhYUFve8QyXTU",
  authDomain: "ai-power-reminder.firebaseapp.com",
  projectId: "ai-power-reminder",
  storageBucket: "ai-power-reminder.firebasestorage.app",
  messagingSenderId: "74414511702",
  appId: "1:74414511702:web:21cd67de249e6afd078df7",
  measurementId: "G-FJDQZRYEY7"
});


// 4. Khởi tạo Firebase Messaging

const messaging = firebase.messaging();


// 5. Nhận thông báo khi ứng dụng chạy nền

messaging.onBackgroundMessage(payload => {

  console.log(
    "[Service Worker] Nhận thông báo:",
    payload
  );

  const title =
    payload.notification?.title ||
    payload.data?.title ||
    "AI POWER REMINDER";

  const body =
    payload.notification?.body ||
    payload.data?.body ||
    "Các bạn hãy kiểm tra và tắt thiết bị điện trước khi ra về nhé!";

  const options = {
    body: body,

    icon: "./icon.svg",

    badge: "./icon.svg",

    data: {
      url: payload.data?.url || "./"
    }
  };

  return self.registration.showNotification(
    title,
    options
  );
});


// =====================================================
// 6. CACHE ỨNG DỤNG PWA
// =====================================================

const CACHE = "ai-power-reminder-v2";

const ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./manifest.webmanifest",
  "./icon.svg"
];


// Cài đặt Service Worker

self.addEventListener("install", event => {

  self.skipWaiting();

  event.waitUntil(
    caches.open(CACHE).then(cache => {
      return cache.addAll(ASSETS);
    })
  );

});


// Kích hoạt Service Worker

self.addEventListener("activate", event => {

  event.waitUntil(
    Promise.all([
      self.clients.claim(),

      caches.keys().then(keys => {
        return Promise.all(
          keys
            .filter(key => key !== CACHE)
            .map(key => caches.delete(key))
        );
      })
    ])
  );

});


// Xử lý yêu cầu tải tài nguyên

self.addEventListener("fetch", event => {

  const url = new URL(event.request.url);

  if (
    url.origin === location.origin &&
    event.request.method === "GET"
  ) {

    event.respondWith(
      caches.match(event.request).then(cached => {

        return cached || fetch(event.request);

      })
    );

  }

});
