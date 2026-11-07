
import admin from "firebase-admin";

// =====================================================
// 1. CẤU HÌNH MÚI GIỜ VIỆT NAM
// =====================================================

const TIMEZONE = "Asia/Ho_Chi_Minh";
const PROJECT_ID = "ai-power-reminder";
const COLLECTION = "dailyMessages";

function getVietnamDate() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());

  const values = {};
  for (const part of parts) {
    values[part.type] = part.value;
  }

  return `${values.year}-${values.month}-${values.day}`;
}

// =====================================================
// 2. KIỂM TRA CÁC API KEY VÀ TÀI KHOẢN FIREBASE
// =====================================================

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const SERVICE_ACCOUNT_SECRET = process.env.FIREBASE_SERVICE_ACCOUNT;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

if (!GEMINI_API_KEY) {
  throw new Error("Thiếu GEMINI_API_KEY trong GitHub Secrets.");
}

if (!SERVICE_ACCOUNT_SECRET) {
  throw new Error("Thiếu FIREBASE_SERVICE_ACCOUNT trong GitHub Secrets.");
}

// Hỗ trợ cả JSON thông thường và JSON dạng Base64.
let serviceAccount;

try {
  serviceAccount = JSON.parse(SERVICE_ACCOUNT_SECRET);
} catch {
  try {
    serviceAccount = JSON.parse(
      Buffer.from(SERVICE_ACCOUNT_SECRET, "base64").toString("utf8")
    );
  } catch {
    throw new Error("FIREBASE_SERVICE_ACCOUNT không phải JSON hợp lệ.");
  }
}

if (serviceAccount.project_id !== PROJECT_ID) {
  throw new Error(
    `Sai Firebase Project ID: ${serviceAccount.project_id || "không xác định"}`
  );
}

// =====================================================
// 3. KHỞI TẠO FIREBASE ADMIN SDK
// =====================================================

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId: PROJECT_ID
});

const db = admin.firestore();

// =====================================================
// 4. TẠO THÔNG ĐIỆP AI BẰNG GEMINI
// =====================================================

async function generateAIMessage(dateKey) {
  const prompt = `
Bạn là chuyên gia giáo dục về tiết kiệm năng lượng trong trường học.

Hãy viết MỘT thông điệp nhắc nhở học sinh lớp 11A2
thực hiện tiết kiệm điện vào cuối buổi học.

Yêu cầu:
- Viết bằng tiếng Việt tự nhiên, gần gũi với học sinh THPT.
- Độ dài khoảng 40 đến 70 từ.
- Có nội dung nhắc tắt đèn, quạt, điều hòa,
  máy chiếu và các thiết bị điện không cần thiết.
- Khuyến khích tinh thần trách nhiệm và bảo vệ môi trường.
- Có thể thay đổi cách diễn đạt mỗi ngày.
- Không viết lời chào dài dòng.
- Chỉ trả về nội dung thông điệp, không thêm tiêu đề.

Ngày áp dụng: ${dateKey}
Đối tượng: Học sinh lớp 11A2.
`;

  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/` +
    `${GEMINI_MODEL}:generateContent`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": GEMINI_API_KEY
    },
    body: JSON.stringify({
      contents: [
        {
          parts: [{ text: prompt }]
        }
      ],
      generationConfig: {
        temperature: 0.8,
        maxOutputTokens: 300
      }
    })
  });

  const result = await response.json();

  if (!response.ok) {
    throw new Error(
      `Gemini API lỗi ${response.status}: ` +
      JSON.stringify(result.error || result)
    );
  }

  const message = result.candidates?.[0]?.content?.parts
    ?.map(part => part.text || "")
    .join("")
    .trim();

  if (!message) {
    throw new Error("Gemini không trả về nội dung thông điệp.");
  }

  return message;
}

// =====================================================
// 5. LƯU THÔNG ĐIỆP VÀO FIRESTORE
// =====================================================

async function main() {
  const dateKey = getVietnamDate();

  console.log("======================================");
  console.log("AI POWER REMINDER - DAILY GENERATOR");
  console.log("Ngày Việt Nam:", dateKey);
  console.log("Firebase:", PROJECT_ID);
  console.log("Gemini model:", GEMINI_MODEL);
  console.log("======================================");

  const messageRef = db.collection(COLLECTION).doc(dateKey);

  // Mỗi ngày chỉ tạo một thông điệp dùng chung cho lớp 11A2.
  const existingDoc = await messageRef.get();

  if (existingDoc.exists) {
    console.log("Thông điệp hôm nay đã tồn tại.");
    console.log("Không tạo lại để bảo đảm học sinh cùng ngày");
    console.log("được sử dụng chung một thông điệp.");
    console.log("Nội dung:", existingDoc.data().message);
    return;
  }

  console.log("Đang yêu cầu Gemini tạo thông điệp...");

  const message = await generateAIMessage(dateKey);

  console.log("Gemini đã tạo thông điệp:");
  console.log(message);

  await messageRef.set({
    dateKey: dateKey,
    classId: "11A2",
    group: "experimental",
    message: message,
    messageType: "ai",
    aiGenerated: true,
    model: GEMINI_MODEL,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    timezone: TIMEZONE
  });

  console.log("======================================");
  console.log("THÀNH CÔNG!");
  console.log("Đã lưu thông điệp vào Firestore.");
  console.log("Collection:", COLLECTION);
  console.log("Document ID:", dateKey);
  console.log("======================================");
}

main().catch(error => {
  console.error("LỖI TẠO THÔNG ĐIỆP AI:");
  console.error(error.message);
  process.exitCode = 1;
});

