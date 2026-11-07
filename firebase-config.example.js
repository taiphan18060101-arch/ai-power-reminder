// 1) Sao chép tệp này thành firebase-config.js
// 2) Thay các giá trị bên dưới bằng Firebase Web App config của dự án.
export const firebaseConfig = {
  apiKey: "DAN_API_KEY_CUA_BAN",
  authDomain: "TEN_DU_AN.firebaseapp.com",
  projectId: "TEN_DU_AN",
  storageBucket: "TEN_DU_AN.firebasestorage.app",
  messagingSenderId: "SENDER_ID",
  appId: "APP_ID"
};

// Email quản trị phải trùng với email được khai báo trong firestore.rules.
export const ADMIN_EMAIL = "EMAIL_GIAO_VIEN_CUA_BAN";
