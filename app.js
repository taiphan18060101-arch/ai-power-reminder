import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";

import {
  getAuth,
  signInAnonymously,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";

import {
  getFirestore,
  collection,
  addDoc,
  getDocs,
  doc,
  getDoc,
  setDoc,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

import {
  firebaseConfig,
  ADMIN_EMAIL,
  VAPID_PUBLIC_KEY
} from "./firebase-config.js";

import {
  getMessaging,
  getToken,
  isSupported,
  onMessage
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-messaging.js";

// ======================================================
// 1. CẤU HÌNH ỨNG DỤNG
// ======================================================

const APP_VERSION = "2.0";
const TIME_ZONE = "Asia/Ho_Chi_Minh";

const CLASSES = ["11A1", "11A2", "11A3", "11A4"];

const DEVICES = [
  {
    id: "lights",
    name: "Đèn chiếu sáng",
    note: "Kiểm tra và tắt hệ thống đèn trong lớp."
  },
  {
    id: "fans",
    name: "Quạt điện",
    note: "Kiểm tra và tắt các quạt điện."
  },
  {
    id: "projector",
    name: "Máy chiếu",
    note: "Tắt máy chiếu đúng quy trình."
  },
  {
    id: "computer",
    name: "Máy tính và thiết bị phụ",
    note: "Tắt máy tính, màn hình và thiết bị phụ."
  }
];

const DEFAULT_MESSAGE =
  "Các bạn hãy dành một phút kiểm tra các thiết bị điện trong lớp. " +
  "Hãy tắt những thiết bị không còn sử dụng trước khi ra về nhé!";

const DEFAULT_SCHEDULE = {
  time: "16:30",
  weekdays: [1, 2, 3, 4, 5]
};

let app;
let auth;
let db;
let currentUser = null;
let messaging = null;
let foregroundMessageHandlerReady = false;

let selected = new Set();
let checkinData = [];


// ======================================================
// 2. HÀM TIỆN ÍCH
// ======================================================

function $(id) {
  return document.getElementById(id);
}

function showOnly(viewId) {
  [
    "studentView",
    "adminView",
    "dashboardView",
    "setupView"
  ].forEach(id => {
    const element = $(id);

    if (element) {
      element.classList.toggle("hidden", id !== viewId);
    }
  });
}

function feedback(id, message, type = "") {
  const element = $(id);

  if (!element) return;

  element.textContent = message;
  element.className = "feedback " + type;
}

function dateKeyVN(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);

  const values = Object.fromEntries(
    parts.map(item => [item.type, item.value])
  );

  return `${values.year}-${values.month}-${values.day}`;
}

function getClassFromUrl() {
  const params = new URLSearchParams(location.search);
  const classId = params.get("class");

  return CLASSES.includes(classId) ? classId : "11A1";
}

function isAdmin() {
  return Boolean(
    currentUser &&
    currentUser.email &&
    currentUser.email.toLowerCase() === ADMIN_EMAIL.toLowerCase()
  );
}


// ======================================================
// 3. THÔNG ĐIỆP AI HẰNG NGÀY
// ======================================================

async function loadDailyMessage() {
  const messageElement = $("reminderMessage");
  const sourceElement = $("messageSource");

  if (!messageElement) return;

  messageElement.textContent = "Đang tải lời nhắc hôm nay...";

  try {
    const today = dateKeyVN();

    const messageRef = doc(db, "dailyMessages", today);
    const messageSnap = await getDoc(messageRef);

    if (messageSnap.exists()) {
      const data = messageSnap.data();

      const message =
        data.message ||
        data.content ||
        data.text ||
        "";

      if (message.trim()) {
        messageElement.textContent = message;

        if (sourceElement) {
          sourceElement.textContent =
            "Thông điệp AI được tạo cho ngày " + today;
        }

        return;
      }
    }

    messageElement.textContent = DEFAULT_MESSAGE;

    if (sourceElement) {
      sourceElement.textContent =
        "Thông điệp mặc định – chưa có nội dung AI hôm nay.";
    }

  } catch (error) {
    console.error("Lỗi tải thông điệp:", error);

    messageElement.textContent = DEFAULT_MESSAGE;

    if (sourceElement) {
      sourceElement.textContent =
        "Không tải được thông điệp AI. Đang sử dụng nội dung mặc định.";
    }
  }
}


// ======================================================
// 4. GIAO DIỆN HỌC SINH
// ======================================================

function renderDevices() {
  const root = $("deviceList");

  if (!root) return;

  selected.clear();

  root.innerHTML = DEVICES.map(device => `
    <label class="device-row">
      <input type="checkbox" data-id="${device.id}">

      <span class="fake-check"></span>

      <span>
        <b>${device.name}</b>
        <small>${device.note}</small>
      </span>
    </label>
  `).join("");

  root.querySelectorAll("input").forEach(input => {
    input.addEventListener("change", () => {
      if (input.checked) {
        selected.add(input.dataset.id);
      } else {
        selected.delete(input.dataset.id);
      }

      updateProgress();
    });
  });

  updateProgress();
}

function updateProgress() {
  const count = selected.size;
  const total = DEVICES.length;
  const percent = Math.round(count / total * 100);

  if ($("progressCount")) {
    $("progressCount").textContent = `${count}/${total}`;
  }

  if ($("progressPercent")) {
    $("progressPercent").textContent = percent + "%";
  }

  if ($("progressBar")) {
    $("progressBar").style.width = percent + "%";
  }

  if ($("submitCheckin")) {
    $("submitCheckin").disabled = !(
      count === total &&
      $("honestConfirm")?.checked &&
      currentUser
    );
  }
}

function setClassUI() {
  const classId = $("classSelect")?.value || "11A1";

  if ($("groupHint")) {
    $("groupHint").textContent =
      `Bạn đang sử dụng ứng dụng nhắc nhở tiết kiệm điện dành cho lớp ${classId}.`;
  }

  if ($("messageLabel")) {
    $("messageLabel").textContent = "THÔNG ĐIỆP NHẮC NHỞ HẰNG NGÀY";
  }
}

async function initStudent() {
  const classSelect = $("classSelect");

  if (classSelect) {
    classSelect.value = getClassFromUrl();

    classSelect.addEventListener("change", () => {
      const classId = classSelect.value;

      history.replaceState(
        {},
        "",
        `${location.pathname}?class=${classId}`
      );

      setClassUI();
    });
  }

  $("honestConfirm")?.addEventListener("change", updateProgress);

  $("submitCheckin")?.addEventListener("click", submitCheckin);
    const notificationButton = $("enableNotificationsButton");

  if (notificationButton) {
    notificationButton.disabled = false;
    notificationButton.addEventListener(
      "click",
      enablePushNotifications
    );
  }

  renderDevices();
  setClassUI();

  try {
    const result = await signInAnonymously(auth);

    currentUser = result.user;

    updateProgress();

    await loadDailyMessage();

  } catch (error) {
    console.error(error);

    feedback(
      "studentFeedback",
      "Không thể kết nối Firebase. Hãy kiểm tra cấu hình và Anonymous Authentication.",
      "error"
    );
  }
}



// ======================================================
// 4A. ĐĂNG KÝ THIẾT BỊ NHẬN THÔNG BÁO FCM
// ======================================================

async function enablePushNotifications() {
  const button = $("enableNotificationsButton");

  try {
    if (!currentUser) {
      throw new Error("Ứng dụng chưa xác thực người dùng. Hãy tải lại trang.");
    }

    if (!("Notification" in window)) {
      throw new Error("Trình duyệt này không hỗ trợ thông báo.");
    }

    if (!("serviceWorker" in navigator)) {
      throw new Error("Trình duyệt không hỗ trợ Service Worker.");
    }

    if (!window.isSecureContext) {
      throw new Error("Thông báo chỉ hoạt động trên HTTPS hoặc localhost.");
    }

    if (!VAPID_PUBLIC_KEY || VAPID_PUBLIC_KEY.trim().length < 20) {
      throw new Error(
        "Chưa tìm thấy VAPID_PUBLIC_KEY trong firebase-config.js."
      );
    }

    const supported = await isSupported();

    if (!supported) {
      throw new Error(
        "Thiết bị hoặc trình duyệt hiện tại chưa hỗ trợ Firebase Cloud Messaging."
      );
    }

    const classId = $("classSelect")?.value || getClassFromUrl();

    if (!CLASSES.includes(classId)) {
      throw new Error("Lớp học không hợp lệ.");
    }

    if (button) {
      button.disabled = true;
      button.textContent = "ĐANG ĐĂNG KÝ...";
    }

    // Yêu cầu quyền phải được thực hiện sau thao tác nhấn nút của người dùng.
    let permission = Notification.permission;

    if (permission === "default") {
      permission = await Notification.requestPermission();
    }

    if (permission !== "granted") {
      throw new Error(
        "Bạn chưa cấp quyền thông báo. Hãy cho phép thông báo trong cài đặt trình duyệt."
      );
    }

    // Đảm bảo Service Worker đã được đăng ký và kích hoạt.
    const registration = await navigator.serviceWorker.ready;

    messaging = getMessaging(app);

    const token = await getToken(messaging, {
      vapidKey: VAPID_PUBLIC_KEY,
      serviceWorkerRegistration: registration
    });

    if (!token) {
      throw new Error(
        "Firebase không trả về FCM token. Kiểm tra VAPID key và cấu hình Firebase."
      );
    }

    // Mỗi tài khoản ẩn danh lưu một đăng ký theo UID.
    // Token không được công khai cho học sinh khác.
    await setDoc(
      doc(db, "pushSubscriptions", currentUser.uid),
      {
        token,
        classId,
        updatedAt: serverTimestamp()
      },
      { merge: true }
    );

    // Khi ứng dụng đang mở, nhận thông báo foreground.
    if (!foregroundMessageHandlerReady) {
      onMessage(messaging, payload => {
        const title =
          payload.notification?.title ||
          payload.data?.title ||
          "AI POWER REMINDER";

        const body =
          payload.notification?.body ||
          payload.data?.body ||
          "Đã đến giờ kiểm tra và tắt các thiết bị điện.";

        feedback(
          "notificationFeedback",
          `${title}: ${body}`,
          "success"
        );
      });

      foregroundMessageHandlerReady = true;
    }

    feedback(
      "notificationFeedback",
      `Đã bật thông báo cho ${classId} trên thiết bị này. Thiết bị đã được đăng ký với Firebase.`,
      "success"
    );

    if (button) {
      button.textContent = "ĐÃ BẬT THÔNG BÁO";
      button.disabled = false;
    }

  } catch (error) {
    console.error("FCM registration error:", error);

    feedback(
      "notificationFeedback",
      error.message || "Không thể đăng ký thông báo.",
      "error"
    );

    if (button) {
      button.textContent = "BẬT THÔNG BÁO";
      button.disabled = false;
    }
  }
}

// ======================================================
// 5. GHI NHẬN XÁC NHẬN CỦA HỌC SINH
// ======================================================

async function submitCheckin() {
  if (!currentUser) return;

  const button = $("submitCheckin");

  if (!button) return;

  button.disabled = true;
  button.textContent = "ĐANG LƯU...";

  try {
    const classId = $("classSelect").value;

    if (!CLASSES.includes(classId)) {
      throw new Error("Lớp học không hợp lệ.");
    }

    if (selected.size !== DEVICES.length) {
      throw new Error("Bạn cần kiểm tra đủ các thiết bị.");
    }

    if (!$("honestConfirm").checked) {
      throw new Error("Bạn cần xác nhận trước khi gửi.");
    }

    const data = {
      classId,

      action: "Tắt thiết bị khi ra về",

      checkedDeviceIds: DEVICES.map(device => device.id),

      checkedDeviceNames: DEVICES.map(device => device.name),

      completion: 100,

      createdAt: serverTimestamp(),

      dateKey: dateKeyVN(),

      appVersion: APP_VERSION
    };

    await addDoc(collection(db, "checkins"), data);

    feedback(
      "studentFeedback",
      "Đã ghi nhận xác nhận thành công. Cảm ơn các bạn đã cùng tiết kiệm điện!",
      "success"
    );

    selected.clear();

    $("honestConfirm").checked = false;

    $("deviceList")
      ?.querySelectorAll("input")
      .forEach(input => input.checked = false);

  } catch (error) {
    console.error(error);

    feedback(
      "studentFeedback",
      error.message || "Không lưu được dữ liệu. Vui lòng thử lại.",
      "error"
    );

  } finally {
    button.textContent = "XÁC NHẬN HOÀN THÀNH";
    updateProgress();
  }
}


// ======================================================
// 6. GIAO DIỆN QUẢN TRỊ GIÁO VIÊN
// ======================================================

function initAdminUI() {
  $("adminLoginButton")?.addEventListener("click", adminLogin);

  $("logoutButton")?.addEventListener("click", async () => {
    await signOut(auth);
  });

  $("refreshButton")?.addEventListener("click", loadAdminData);

  $("updatePublicStatsButton")?.addEventListener(
    "click",
    publishPublicStats
  );

  $("exportButton")?.addEventListener("click", exportCSV);

  $("saveReminderScheduleButton")?.addEventListener(
    "click",
    saveReminderSchedule
  );

  document.querySelectorAll("[data-qr]").forEach(button => {
    button.addEventListener("click", () => {
      downloadQR(button.dataset.qr);
    });
  });
}

async function adminLogin() {
  const email = $("adminEmail")?.value.trim();
  const password = $("adminPassword")?.value;

  try {
    const credential = await signInWithEmailAndPassword(
      auth,
      email,
      password
    );

    if (
      (credential.user.email || "").toLowerCase() !==
      ADMIN_EMAIL.toLowerCase()
    ) {
      await signOut(auth);

      throw new Error("Tài khoản này không có quyền quản trị.");
    }

  } catch (error) {
    console.error(error);

    feedback(
      "adminLoginFeedback",
      "Đăng nhập thất bại: " + (error.message || "Kiểm tra lại thông tin."),
      "error"
    );
  }
}
      "adminLoginFeedback",
      "Đăng nhập thất bại: " + (error.message || "Kiểm tra lại thông tin."),
      "error"
    );
  }
}

async function showAdminDashboard(user) {
  currentUser = user;

  const scheduleButton = $("saveReminderScheduleButton");
  if (scheduleButton) scheduleButton.disabled = false;

  $("adminLogin")?.classList.add("hidden");
  $("adminDashboard")?.classList.remove("hidden");

  if ($("adminIdentity")) {
    $("adminIdentity").textContent = "Đã đăng nhập: " + user.email;
  }

  await loadAdminData();
  await loadReminderSchedule();

  makeQRs();
}


// ======================================================
// 7. TẢI DỮ LIỆU QUẢN TRỊ
// ======================================================

async function loadAdminData() {
  if (!isAdmin()) return;

  try {
    const snapshot = await getDocs(collection(db, "checkins"));

    checkinData = snapshot.docs.map(item => ({
      id: item.id,
      ...item.data()
    }));

    checkinData.sort((a, b) =>
      (b.createdAt?.toMillis?.() || 0) -
      (a.createdAt?.toMillis?.() || 0)
    );

    const today = dateKeyVN();

    const todayRows = checkinData.filter(
      item => item.dateKey === today
    );

    if ($("totalCheckins")) {
      $("totalCheckins").textContent = checkinData.length;
    }

    if ($("todayCheckins")) {
      $("todayCheckins").textContent = todayRows.length;
    }

    renderClassStats();
    renderRecentCheckins();

    feedback(
      "adminLoginFeedback",
      "Đã tải dữ liệu thành công.",
      "success"
    );

  } catch (error) {
    console.error(error);

    feedback(
      "adminLoginFeedback",
      "Không tải được dữ liệu. Kiểm tra Firestore Rules.",
      "error"
    );
  }
}

function renderClassStats() {
  const root = $("classStats");

  if (!root) return;

  root.innerHTML = CLASSES.map(classId => {
    const count = checkinData.filter(
      item => item.classId === classId
    ).length;

    return `
      <div class="class-stat">
        <b>${classId}</b>
        <strong>${count}</strong>
        <small>Lượt xác nhận đã ghi nhận</small>
      </div>
    `;
  }).join("");
}

function renderRecentCheckins() {
  const root = $("recentCheckins");

  if (!root) return;

  root.innerHTML = checkinData.slice(0, 30).map(item => {
    const time = item.createdAt?.toDate
      ? item.createdAt.toDate().toLocaleString("vi-VN")
      : "Không rõ thời gian";

    return `
      <div class="recent-row">
        <div>
          <b>${item.classId || "—"} · ${item.action || "Xác nhận"}</b>
          <small>
            ${time} · ${(item.checkedDeviceNames || []).length} thiết bị
          </small>
        </div>

        <span class="class-badge">${item.completion || 0}%</span>
      </div>
    `;
  }).join("") || '<p class="muted">Chưa có lượt xác nhận.</p>';
}


// ======================================================
// 8. CẤU HÌNH LỊCH NHẮC CHUNG CHO 4 LỚP
// ======================================================

function getSelectedWeekdays() {
  return [...document.querySelectorAll(
    'input[name="reminderWeekday"]:checked'
  )].map(input => Number(input.value));
}

function setSelectedWeekdays(weekdays) {
  document.querySelectorAll(
    'input[name="reminderWeekday"]'
  ).forEach(input => {
    input.checked = weekdays.includes(Number(input.value));
  });
}

async function loadReminderSchedule() {
  if (!isAdmin()) return;

  try {
    const snapshot = await getDoc(
      doc(db, "settings", "reminderSchedule")
    );

    const schedule = snapshot.exists()
      ? snapshot.data()
      : DEFAULT_SCHEDULE;

    if ($("reminderTime")) {
      $("reminderTime").value =
        schedule.time || DEFAULT_SCHEDULE.time;
    }

    setSelectedWeekdays(
      Array.isArray(schedule.weekdays)
        ? schedule.weekdays
        : DEFAULT_SCHEDULE.weekdays
    );

  } catch (error) {
    console.error("Không tải được lịch:", error);

    feedback(
      "scheduleFeedback",
      "Chưa tải được lịch nhắc. Cần kiểm tra quyền truy cập settings.",
      "error"
    );
  }
}

async function saveReminderSchedule() {
  if (!isAdmin()) {
    feedback(
      "scheduleFeedback",
      "Bạn cần đăng nhập bằng tài khoản giáo viên.",
      "error"
    );
    return;
  }

  const time = $("reminderTime")?.value;
  const weekdays = getSelectedWeekdays();

  if (!time) {
    feedback("scheduleFeedback", "Hãy chọn giờ nhắc.", "error");
    return;
  }

  if (weekdays.length === 0) {
    feedback(
      "scheduleFeedback",
      "Hãy chọn ít nhất một ngày trong tuần.",
      "error"
    );
    return;
  }

  const button = $("saveReminderScheduleButton");

  if (button) {
    button.disabled = true;
    button.textContent = "ĐANG LƯU...";
  }

  try {
    await setDoc(
      doc(db, "settings", "reminderSchedule"),
      {
        time,
        weekdays,
        timeZone: TIME_ZONE,
        updatedAt: serverTimestamp(),
        updatedBy: ADMIN_EMAIL
      }
    );

    feedback(
      "scheduleFeedback",
      "Đã lưu lịch nhắc chung cho cả 4 lớp.",
      "success"
    );

  } catch (error) {
    console.error(error);

    feedback(
      "scheduleFeedback",
      "Lưu lịch thất bại. Cần bổ sung quyền truy cập settings trong Firestore Rules.",
      "error"
    );

  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = "LƯU LỊCH NHẮC";
    }
  }
}


// ======================================================
// 9. TẠO VÀ TẢI MÃ QR CHO 4 LỚP
// ======================================================

function makeQRs() {
  const base = location.origin + location.pathname;

  CLASSES.forEach(classId => {
    const id = "qr" + classId.toLowerCase();
    const element = $(id);

    if (!element) return;

    element.innerHTML = "";

    const url = `${base}?class=${classId}`;

    if (window.QRCode) {
      new QRCode(element, {
        text: url,
        width: 130,
        height: 130
      });
    } else {
      element.textContent = url;
    }
  });
}

function downloadQR(classId) {
  if (!CLASSES.includes(classId)) return;

  const id = "qr" + classId.toLowerCase();
  const element = $(id);

  if (!element) return;

  const canvas = element.querySelector("canvas");
  const image = element.querySelector("img");

  const url = canvas
    ? canvas.toDataURL("image/png")
    : image?.src;

  if (!url) {
    feedback(
      "qrFeedback",
      "Chưa tạo được mã QR. Hãy tải lại trang.",
      "error"
    );
    return;
  }

  const link = document.createElement("a");

  link.href = url;
  link.download = `QR_${classId}.png`;
  link.click();
}
// ======================================================
// 10. XUẤT DỮ LIỆU CSV
// ======================================================

function exportCSV() {
  const rows = [
    [
      "Lop",
      "Thao tac",
      "Thiet bi da xac nhan",
      "Thoi gian",
      "Phan tram",
      "Phien ban"
    ],
    ...checkinData.map(item => [
      item.classId,
      item.action,
      (item.checkedDeviceNames || []).join("; "),
      item.createdAt?.toDate
        ? item.createdAt.toDate().toLocaleString("vi-VN")
        : "",
      item.completion,
      item.appVersion
    ])
  ];

  const csv = "\uFEFF" + rows.map(row =>
    row.map(value =>
      '"' + String(value ?? "").replace(/"/g, '""') + '"'
    ).join(",")
  ).join("\r\n");

  const blob = new Blob(
    [csv],
    { type: "text/csv;charset=utf-8" }
  );

  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = "du_lieu_AI_Power_Reminder_V2.csv";
  link.click();

  URL.revokeObjectURL(url);
}


// ======================================================
// 11. THỐNG KÊ CÔNG KHAI
// ======================================================

async function publishPublicStats() {
  if (!isAdmin()) {
    feedback(
      "publicStatsFeedback",
      "Bạn cần đăng nhập bằng tài khoản giáo viên.",
      "error"
    );
    return;
  }

  const button = $("updatePublicStatsButton");

  if (button) {
    button.disabled = true;
    button.textContent = "ĐANG CẬP NHẬT...";
  }

  try {
    const classCounts = {
      "11A1": 0,
      "11A2": 0,
      "11A3": 0,
      "11A4": 0
    };

    const dailyCounts = {};

    for (const row of checkinData) {
      if (!CLASSES.includes(row.classId)) continue;

      classCounts[row.classId]++;

      const day = row.dateKey || "khong-ro";

      if (!dailyCounts[day]) {
        dailyCounts[day] = {
          "11A1": 0,
          "11A2": 0,
          "11A3": 0,
          "11A4": 0,
          total: 0
        };
      }

      dailyCounts[day][row.classId]++;
      dailyCounts[day].total++;
    }

    await setDoc(
      doc(db, "publicStats", "dashboard"),
      {
        totalCheckins: checkinData.length,

        classCounts,

        dailyCounts,

        updatedAt: serverTimestamp(),

        updatedBy: "teacher"
      }
    );

    feedback(
      "publicStatsFeedback",
      "Đã cập nhật thống kê công khai.",
      "success"
    );

  } catch (error) {
    console.error(error);

    feedback(
      "publicStatsFeedback",
      "Cập nhật thất bại. Kiểm tra Firestore Rules.",
      "error"
    );

  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = "CẬP NHẬT THỐNG KÊ CÔNG KHAI";
    }
  }
}

async function loadPublicDashboard() {
  try {
    const snapshot = await getDoc(
      doc(db, "publicStats", "dashboard")
    );

    if (!snapshot.exists()) {
      throw new Error(
        "Chưa có dữ liệu. Giáo viên cần cập nhật thống kê."
      );
    }

    const data = snapshot.data();

    $("publicTotal").textContent = data.totalCheckins ?? 0;

    CLASSES.forEach(classId => {
      const element = $("public" + classId);

      if (element) {
        element.textContent =
          data.classCounts?.[classId] ?? 0;
      }
    });

    const updated = data.updatedAt?.toDate
      ? data.updatedAt.toDate().toLocaleString("vi-VN")
      : "Chưa rõ";

    $("publicUpdatedAt").textContent =
      "Cập nhật lần cuối: " + updated;

    renderDailyChart(data.dailyCounts || {});

  } catch (error) {
    console.error(error);

    feedback(
      "dashboardFeedback",
      error.message || "Không tải được thống kê.",
      "error"
    );
  }
}

function renderDailyChart(dailyCounts) {
  const entries = Object.entries(dailyCounts)
    .filter(([day]) => /^\d{4}-\d{2}-\d{2}$/.test(day))
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-14);

  const root = $("dailyChart");

  if (!root) return;

  if (entries.length === 0) {
    root.innerHTML =
      '<p class="muted">Chưa có dữ liệu theo ngày.</p>';
    return;
  }

  const max = Math.max(
    1,
    ...entries.map(([, value]) => value.total || 0)
  );

  root.innerHTML = entries.map(([day, value]) => {
    const total = value.total || 0;
    const width = total / max * 100;

    return `
      <div class="chart-day">
        <div class="chart-date">
          ${day.split("-").reverse().slice(0, 2).join("/")}
        </div>

        <div class="chart-bars">
          <div class="chart-bar-row">
            <span>Tổng lượt</span>

            <div class="chart-track">
              <div
                class="chart-fill"
                style="width:${width}%"
              ></div>
            </div>

            <b>${total}</b>
          </div>
        </div>
      </div>
    `;
  }).join("");
}


// ======================================================
// 12. KHỞI ĐỘNG ỨNG DỤNG
// ======================================================

async function boot() {
  const params = new URLSearchParams(location.search);

  const adminMode = params.has("admin");
  const dashboardMode = params.has("dashboard");

  try {
    if (!firebaseConfig.apiKey) {
      throw new Error("Firebase chưa được cấu hình.");
    }

    app = initializeApp(firebaseConfig);
    auth = getAuth(app);
    db = getFirestore(app);

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker
        .register("./sw.js")
        .catch(error => console.warn("Service Worker:", error));
    }

    if (dashboardMode) {
      showOnly("dashboardView");

      await loadPublicDashboard();

      $("dashboardReloadButton")
        ?.addEventListener("click", loadPublicDashboard);

    } else if (adminMode) {
      showOnly("adminView");

      initAdminUI();

      onAuthStateChanged(auth, async user => {
        if (
          user?.email?.toLowerCase() === ADMIN_EMAIL.toLowerCase()
        ) {
          await showAdminDashboard(user);
        } else {
          currentUser = null;

          $("adminLogin")?.classList.remove("hidden");
          $("adminDashboard")?.classList.add("hidden");
        }
      });

    } else {
      showOnly("studentView");

      await initStudent();
    }

  } catch (error) {
    console.error("Lỗi khởi động:", error);

    showOnly("setupView");
  }
}

boot();
