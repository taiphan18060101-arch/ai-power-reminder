
const admin = require("firebase-admin");

const TIME_ZONE = "Asia/Ho_Chi_Minh";
const PROJECT_ID = "ai-power-reminder";

const ALLOWED_CLASSES = ["11A1", "11A2", "11A3", "11A4"];

const FALLBACK_MESSAGE =
  "Các bạn hãy kiểm tra và tắt đèn, quạt, máy chiếu, máy tính " +
  "trước khi ra về nhé!";

// ------------------------------------------------------
// 1. KHỞI TẠO FIREBASE ADMIN
// ------------------------------------------------------

function initializeFirebase() {
  if (admin.apps.length) return;

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;

  if (!raw) {
    throw new Error("Thiếu FIREBASE_SERVICE_ACCOUNT.");
  }

  const serviceAccount = JSON.parse(raw);

  if (serviceAccount.project_id !== PROJECT_ID) {
    throw new Error("Service Account không thuộc dự án AI Power Reminder.");
  }

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId: PROJECT_ID
  });
}

// ------------------------------------------------------
// 2. LẤY THỜI GIAN VIỆT NAM
// ------------------------------------------------------

function getVietnamTime() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TIME_ZONE,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date());

  const values = Object.fromEntries(
    parts.map(part => [part.type, part.value])
  );

  const weekdayMap = {
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
    Sun: 7
  };

  return {
    weekday: weekdayMap[values.weekday],
    hour: Number(values.hour),
    minute: Number(values.minute)
  };
}

function getVietnamDateKey() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}

// ------------------------------------------------------
// 3. ĐỌC LỊCH NHẮC TỪ FIRESTORE
// ------------------------------------------------------

async function loadSchedule(db) {
  const ref = db.collection("settings")
    .doc("reminderSchedule");

  const snapshot = await ref.get();

  if (!snapshot.exists) {
    console.log("Chưa có lịch nhắc. Dừng chương trình.");
    return null;
  }

  const schedule = snapshot.data();

  if (
    !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(schedule.time || "")
  ) {
    throw new Error("Giờ nhắc không hợp lệ.");
  }

  if (
    !Array.isArray(schedule.weekdays) ||
    schedule.weekdays.length === 0 ||
    schedule.weekdays.some(day =>
      !Number.isInteger(day) || day < 1 || day > 7
    )
  ) {
    throw new Error("Danh sách ngày nhắc không hợp lệ.");
  }

  return schedule;
}

// ------------------------------------------------------
// 4. KIỂM TRA ĐÃ ĐẾN GIỜ GỬI CHƯA
// ------------------------------------------------------

function shouldSend(schedule) {
  const now = getVietnamTime();

  const [targetHour, targetMinute] =
    schedule.time.split(":").map(Number);

  const currentMinutes = now.hour * 60 + now.minute;
  const targetMinutes = targetHour * 60 + targetMinute;

  const delay = currentMinutes - targetMinutes;

  // Cho phép workflow chạy trễ tối đa 14 phút.
  const inTimeWindow = delay >= 0 && delay < 15;

  const correctWeekday =
    schedule.weekdays.includes(now.weekday);

  console.log("Giờ Việt Nam:", now);
  console.log("Giờ nhắc:", schedule.time);
  console.log("Độ trễ:", delay, "phút");

  return inTimeWindow && correctWeekday;
}

// ------------------------------------------------------
// 5. ĐỌC THÔNG ĐIỆP AI HÔM NAY
// ------------------------------------------------------

async function loadDailyMessage(db) {
  const dateKey = getVietnamDateKey();

  const snapshot = await db.collection("dailyMessages")
    .doc(dateKey)
    .get();

  if (!snapshot.exists) {
    console.log("Chưa có thông điệp AI. Dùng nội dung dự phòng.");
    return FALLBACK_MESSAGE;
  }

  const data = snapshot.data();

  const message =
    data.message ||
    data.content ||
    data.text ||
    "";

  return message.trim() || FALLBACK_MESSAGE;
}

// ------------------------------------------------------
// 6. ĐỌC DANH SÁCH FCM TOKEN
// ------------------------------------------------------

async function loadTokens(db) {
  const snapshot = await db.collection("pushSubscriptions").get();

  const tokenMap = new Map();

  snapshot.forEach(document => {
    const data = document.data();

    if (
      typeof data.token === "string" &&
      data.token.length > 0 &&
      ALLOWED_CLASSES.includes(data.classId)
    ) {
      // Một token chỉ gửi một lần dù dữ liệu bị trùng.
      tokenMap.set(data.token, {
        uid: document.id,
        classId: data.classId
      });
    }
  });

  return [...tokenMap.entries()].map(([token, info]) => ({
    token,
    ...info
  }));
}

// ------------------------------------------------------
// 7. CHỐNG GỬI TRÙNG
// ------------------------------------------------------

async function claimSend(db, runId) {
  const ref = db.collection("notificationRuns").doc(runId);

  return db.runTransaction(async transaction => {
    const snapshot = await transaction.get(ref);

    if (snapshot.exists) {
      const data = snapshot.data();

      if (data.status === "sent") {
        return false;
      }

      if (data.status === "sending") {
        const lastAttempt = data.updatedAt?.toDate?.();

        if (
          lastAttempt &&
          Date.now() - lastAttempt.getTime() < 15 * 60 * 1000
        ) {
          return false;
        }
      }
    }

    transaction.set(ref, {
      status: "sending",
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    return true;
  });
}

// ------------------------------------------------------
// 8. GỬI THÔNG BÁO FCM
// ------------------------------------------------------

async function sendNotifications(tokens, message) {
  const messaging = admin.messaging();

  let successCount = 0;
  let failureCount = 0;

  // FCM multicast giới hạn 500 token mỗi lần.
  for (let i = 0; i < tokens.length; i += 500) {
    const batch = tokens.slice(i, i + 500);

    const response = await messaging.sendEachForMulticast({
      tokens: batch.map(item => item.token),

      // Gửi data-only để Service Worker tự hiển thị.
      data: {
        title: "AI POWER REMINDER",
        body: message,
        url: "https://taiphan18060101-arch.github.io/ai-power-reminder/"
      },

      webpush: {
        headers: {
          TTL: "3600",
          Urgency: "high"
        }
      }
    });

    successCount += response.successCount;
    failureCount += response.failureCount;

    // Xóa token không còn hợp lệ.
    const deletions = [];

    response.responses.forEach((result, index) => {
      if (
        !result.success &&
        (
          result.error?.code === "messaging/registration-token-not-registered" ||
          result.error?.code === "messaging/invalid-registration-token"
        )
      ) {
        deletions.push(
          admin.firestore()
            .collection("pushSubscriptions")
            .doc(batch[index].uid)
            .delete()
        );
      }
    });

    await Promise.all(deletions);
  }

  return { successCount, failureCount };
}

// ------------------------------------------------------
// 9. CHƯƠNG TRÌNH CHÍNH
// ------------------------------------------------------

async function main() {
  initializeFirebase();

  const db = admin.firestore();

  console.log("===== AI POWER REMINDER =====");

  const schedule = await loadSchedule(db);

  if (!schedule) return;

  if (!shouldSend(schedule)) {
    console.log("Chưa đến thời gian gửi thông báo.");
    return;
  }

  const dateKey = getVietnamDateKey();

  const runId =
    `${dateKey}_${schedule.time.replace(":", "-")}`;

  const claimed = await claimSend(db, runId);

  if (!claimed) {
    console.log("Lượt gửi này đã được xử lý hoặc đang chạy.");
    return;
  }

  try {
    const message = await loadDailyMessage(db);

    const tokens = await loadTokens(db);

    if (tokens.length === 0) {
      throw new Error("Chưa có thiết bị nào đăng ký nhận thông báo.");
    }

    console.log("Số thiết bị:", tokens.length);

    const result = await sendNotifications(tokens, message);

    await db.collection("notificationRuns").doc(runId).set({
      status: "sent",
      dateKey,
      scheduledTime: schedule.time,
      totalDevices: tokens.length,
      successCount: result.successCount,
      failureCount: result.failureCount,
      sentAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    console.log("Gửi thông báo hoàn tất:", result);

  } catch (error) {
    await db.collection("notificationRuns").doc(runId).set({
      status: "failed",
      error: error.message,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    throw error;
  }
}

main().catch(error => {
  console.error("GỬI THÔNG BÁO THẤT BẠI:", error);
  process.exitCode = 1;
});

