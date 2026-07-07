// Dán config Firebase của bạn vào đây.
// Lấy tại: Firebase Console > Project settings > General > "Your apps" > SDK setup and configuration
//
// Lưu ý: các giá trị này (đặc biệt apiKey) là công khai theo thiết kế của Firebase —
// bảo mật thực sự nằm ở Realtime Database Rules (xem rules.json), không phải ở việc giấu file này.

export const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
  databaseURL: "https://YOUR_PROJECT_ID-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT_ID.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID",
};
