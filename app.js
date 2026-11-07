import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import {
  getAuth, signInAnonymously, signInWithEmailAndPassword, signOut,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import {
  getFirestore, collection, addDoc, getDocs, doc, getDoc, setDoc,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";
import { firebaseConfig, ADMIN_EMAIL } from "./firebase-config.js";

const DEVICES = [
  {id:"lights",name:"Đèn chiếu sáng",note:"Kiểm tra các công tắc đèn trong lớp"},
  {id:"fans",name:"Quạt điện",note:"Kiểm tra và tắt quạt khi không còn sử dụng"},
  {id:"aircon",name:"Điều hòa",note:"Tắt điều hòa theo hướng dẫn của giáo viên"},
  {id:"projector",name:"Máy chiếu",note:"Tắt máy chiếu đúng quy trình"},
  {id:"computer",name:"Máy tính và thiết bị phụ",note:"Tắt máy tính, màn hình và thiết bị không cần thiết"}
];
const FIXED_MESSAGE = "Các bạn hãy dành một phút kiểm tra đèn, quạt, điều hòa và các thiết bị điện. Hãy tắt những thiết bị không còn sử dụng trước khi ra về nhé!";
const TIME_ZONE = "Asia/Ho_Chi_Minh";
let app, auth, db, currentUser, selected = new Set(), checkinData = [];

function $(id) { return document.getElementById(id); }
function showOnly(viewId){
  ["studentView","adminView","dashboardView","setupView"].forEach(id=>{
    const el=$(id); if(el) el.classList.toggle("hidden",id!==viewId);
  });
}
function feedback(id,msg,type=""){
  const el=$(id); if(!el)return; el.textContent=msg; el.className="feedback "+type;
}
function dateKeyVN(date=new Date()){
  const parts=new Intl.DateTimeFormat("en-CA",{
    timeZone:TIME_ZONE,year:"numeric",month:"2-digit",day:"2-digit"
  }).formatToParts(date);
  const p=Object.fromEntries(parts.map(x=>[x.type,x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
function getClassFromUrl(){
  const c=new URLSearchParams(location.search).get("class");
  return c==="11A2"?"11A2":"11A1";
}
function renderDevices(){
  $("deviceList").innerHTML=DEVICES.map(d=>`
    <label class="device-row">
      <input type="checkbox" data-id="${d.id}">
      <span class="fake-check"></span>
      <span><b>${d.name}</b><small>${d.note}</small></span>
    </label>`).join("");
  $("deviceList").querySelectorAll("input").forEach(input=>{
    input.addEventListener("change",()=>{
      input.checked?selected.add(input.dataset.id):selected.delete(input.dataset.id);
      updateProgress();
    });
  });
  updateProgress();
}
function updateProgress(){
  const n=selected.size,total=DEVICES.length,p=Math.round(n/total*100);
  $("progressCount").textContent=`${n}/${total}`;
  $("progressPercent").textContent=p+"%";
  $("progressBar").style.width=p+"%";
  $("submitCheckin").disabled=!(n===total && $("honestConfirm").checked && currentUser);
}
function setClassUI(){
  const cls=$("classSelect").value;
  $("groupHint").textContent=cls==="11A1"?"Nhóm đối chứng · Sử dụng lời nhắc cố định.":"Nhóm thực nghiệm · Hiện đang sử dụng thông điệp nền V1.0; AI chưa được tích hợp.";
  $("messageLabel").textContent=cls==="11A1"?"LỜI NHẮC CỐ ĐỊNH":"THÔNG ĐIỆP NHẮC NHỞ";
  $("reminderMessage").textContent=FIXED_MESSAGE;
  $("messageSource").textContent=cls==="11A1"?"Thông điệp cố định – nhóm đối chứng.":"Thông điệp nền V1.0 – AI sẽ được tích hợp ở phiên bản sau.";
}
async function initStudent(){
  $("classSelect").value=getClassFromUrl();
  $("classSelect").addEventListener("change",()=>{
    const c=$("classSelect").value;
    history.replaceState({},"",`${location.pathname}?class=${c}`);
    setClassUI();
  });
  $("honestConfirm").addEventListener("change",updateProgress);
  $("submitCheckin").addEventListener("click",submitCheckin);
  renderDevices();setClassUI();
  try{const result=await signInAnonymously(auth);currentUser=result.user;updateProgress();}
  catch(e){feedback("studentFeedback","Chưa kết nối được hệ thống. Hãy kiểm tra Firebase và Anonymous Authentication.","error");}
}
async function submitCheckin(){
  if(!currentUser)return;
  const btn=$("submitCheckin");btn.disabled=true;btn.textContent="ĐANG LƯU...";
  try{
    const cls=$("classSelect").value;
    const data={
      classId:cls,group:cls==="11A1"?"control":"experimental",
      action:"Tắt thiết bị khi ra về",
      checkedDeviceIds:DEVICES.map(d=>d.id),checkedDeviceNames:DEVICES.map(d=>d.name),
      completion:100,createdAt:serverTimestamp(),dateKey:dateKeyVN(),appVersion:"1.0"
    };
    await addDoc(collection(db,"checkins"),data);
    feedback("studentFeedback","Đã ghi nhận xác nhận. Cảm ơn các bạn đã cùng tiết kiệm điện!","success");
    selected.clear();$("honestConfirm").checked=false;
    $("deviceList").querySelectorAll("input").forEach(i=>i.checked=false);
  }catch(e){console.error(e);feedback("studentFeedback","Không lưu được dữ liệu. Vui lòng thử lại hoặc báo giáo viên.","error");}
  finally{btn.textContent="XÁC NHẬN HOÀN THÀNH";updateProgress();}
}

function initAdminUI(){
  $("adminLoginButton").addEventListener("click",adminLogin);
  $("logoutButton").addEventListener("click",async()=>{
    await signOut(auth);$("adminDashboard").classList.add("hidden");$("adminLogin").classList.remove("hidden");
  });
  $("refreshButton").addEventListener("click",loadAdminData);
  $("updatePublicStatsButton").addEventListener("click",publishPublicStats);
  $("exportButton").addEventListener("click",exportCSV);
  document.querySelectorAll("[data-qr]").forEach(b=>b.addEventListener("click",()=>downloadQR(b.dataset.qr)));
}
async function adminLogin(){
  const email=$("adminEmail").value.trim(),password=$("adminPassword").value;
  try{
    const cred=await signInWithEmailAndPassword(auth,email,password);
    if((cred.user.email||"").toLowerCase()!==ADMIN_EMAIL.toLowerCase()){
      await signOut(auth);throw new Error("Tài khoản này không được cấp quyền quản trị.");
    }
    currentUser=cred.user;
    $("adminLogin").classList.add("hidden");$("adminDashboard").classList.remove("hidden");
    $("adminIdentity").textContent="Đã đăng nhập: "+cred.user.email;
    await loadAdminData();makeQRs();
  }catch(e){feedback("adminLoginFeedback","Không đăng nhập được: "+(e.message||"Kiểm tra email và mật khẩu."),"error");}
}
async function loadAdminData(){
  try{
    // Đọc toàn bộ checkins để thống kê không bị giới hạn ở 500 bản ghi.
    const snap=await getDocs(collection(db,"checkins"));
    checkinData=snap.docs.map(d=>({id:d.id,...d.data()}));
    checkinData.sort((a,b)=>(b.createdAt?.toMillis?.()||0)-(a.createdAt?.toMillis?.()||0));
    const today=dateKeyVN();
    $("totalCheckins").textContent=checkinData.length;
    $("todayCheckins").textContent=checkinData.filter(x=>x.dateKey===today).length;
    $("classStats").innerHTML=["11A1","11A2"].map(cls=>{
      const rows=checkinData.filter(x=>x.classId===cls);
      const label=cls==="11A1"?"Đối chứng":"Thực nghiệm";
      return `<div class="class-stat"><b>${cls} · ${label}</b><strong>${rows.length}</strong><small>Lượt xác nhận đã ghi nhận</small></div>`;
    }).join("");
    $("recentCheckins").innerHTML=checkinData.slice(0,30).map(x=>`
      <div class="recent-row"><div><b>${x.classId||"—"} · ${x.action||"Xác nhận"}</b>
      <small>${x.createdAt?.toDate?x.createdAt.toDate().toLocaleString("vi-VN"):"Không rõ thời gian"} · ${(x.checkedDeviceNames||[]).length} thiết bị</small></div>
      <span class="class-badge">${x.completion||0}%</span></div>`).join("")||'<p class="muted">Chưa có lượt xác nhận.</p>';
    feedback("adminLoginFeedback","Đã tải dữ liệu chi tiết.","success");
  }catch(e){console.error(e);feedback("adminLoginFeedback","Không tải được dữ liệu. Kiểm tra Firestore Rules và quyền giáo viên.","error");}
}
async function publishPublicStats(){
  if(!currentUser || currentUser.email?.toLowerCase()!==ADMIN_EMAIL.toLowerCase()){
    feedback("publicStatsFeedback","Bạn cần đăng nhập bằng tài khoản giáo viên.","error");return;
  }
  const btn=$("updatePublicStatsButton");btn.disabled=true;btn.textContent="ĐANG CẬP NHẬT...";
  try{
    // Tính lại từ dữ liệu checkins đã đọc, không cộng dồn nên tránh tăng trùng.
    const dailyCounts={};
    let class11A1=0,class11A2=0;
    for(const row of checkinData){
      if(row.classId==="11A1")class11A1++;
      if(row.classId==="11A2")class11A2++;
      const day=typeof row.dateKey==="string"?row.dateKey:"khong-ro";
      if(!dailyCounts[day])dailyCounts[day]={class11A1:0,class11A2:0,total:0};
      if(row.classId==="11A1")dailyCounts[day].class11A1++;
      if(row.classId==="11A2")dailyCounts[day].class11A2++;
      dailyCounts[day].total++;
    }
    await setDoc(doc(db,"publicStats","dashboard"),{
      totalCheckins:checkinData.length,class11A1,class11A2,dailyCounts,
      updatedAt:serverTimestamp(),updatedBy:"teacher"
    });
    feedback("publicStatsFeedback","Đã cập nhật thống kê công khai thành công.","success");
  }catch(e){console.error(e);feedback("publicStatsFeedback","Cập nhật thất bại. Kiểm tra Rules, đăng nhập và dữ liệu Firestore.","error");}
  finally{btn.disabled=false;btn.textContent="CẬP NHẬT THỐNG KÊ CÔNG KHAI";}
}
function makeQRs(){
  const base=location.origin+location.pathname;
  [["11A1","qr11a1"],["11A2","qr11a2"]].forEach(([cls,id])=>{
    const el=$(id);el.innerHTML="";
    if(window.QRCode)new QRCode(el,{text:`${base}?class=${cls}`,width:130,height:130});
    else el.textContent=`${base}?class=${cls}`;
  });
}
function downloadQR(cls){
  const id=cls==="11A1"?"qr11a1":"qr11a2",el=$(id);
  const canvas=el.querySelector("canvas"),img=el.querySelector("img");
  const url=canvas?canvas.toDataURL("image/png"):img?.src;
  if(!url){feedback("qrFeedback","Chưa tạo được QR. Hãy thử tải lại trang.","error");return;}
  const a=document.createElement("a");a.href=url;a.download=`QR_${cls}.png`;a.click();
}
function exportCSV(){
  const rows=[["Lop","Nhom","Thao tac","Thiet bi da xac nhan","Thoi gian","Phan tram"],...checkinData.map(x=>[
    x.classId,x.group,x.action,(x.checkedDeviceNames||[]).join("; "),
    x.createdAt?.toDate?x.createdAt.toDate().toLocaleString("vi-VN"):"",x.completion
  ])];
  const csv="\uFEFF"+rows.map(r=>r.map(v=>'"'+String(v??"").replace(/"/g,'""')+'"').join(",")).join("\r\n");
  const blob=new Blob([csv],{type:"text/csv;charset=utf-8"}),url=URL.createObjectURL(blob);
  const a=document.createElement("a");a.href=url;a.download="du_lieu_nghien_cuu_ai_power_reminder.csv";a.click();URL.revokeObjectURL(url);
}

async function loadPublicDashboard(){
  try{
    const snap=await getDoc(doc(db,"publicStats","dashboard"));
    if(!snap.exists())throw new Error("Chưa có dữ liệu thống kê. Giáo viên cần cập nhật từ trang quản trị.");
    const data=snap.data();
    $("publicTotal").textContent=data.totalCheckins??0;
    $("public11A1").textContent=data.class11A1??0;
    $("public11A2").textContent=data.class11A2??0;
    const updated=data.updatedAt?.toDate?data.updatedAt.toDate().toLocaleString("vi-VN"):"Chưa rõ";
    $("publicUpdatedAt").textContent="Cập nhật lần cuối: "+updated;
    renderDailyChart(data.dailyCounts||{});
  }catch(e){console.error(e);feedback("dashboardFeedback",e.message||"Không tải được thống kê.","error");}
}
function renderDailyChart(dailyCounts){
  const entries=Object.entries(dailyCounts)
    .filter(([k])=>/^\d{4}-\d{2}-\d{2}$/.test(k))
    .sort(([a],[b])=>a.localeCompare(b)).slice(-14);
  const root=$("dailyChart");
  if(!entries.length){root.innerHTML='<p class="muted">Chưa có dữ liệu theo ngày.</p>';return;}
  const max=Math.max(1,...entries.flatMap(([,v])=>[v.class11A1||0,v.class11A2||0]));
  root.innerHTML=entries.map(([day,v])=>{
    const a=v.class11A1||0,b=v.class11A2||0;
    return `<div class="chart-day"><div class="chart-date">${day.split("-").reverse().slice(0,2).join("/")}</div>
      <div class="chart-bars"><div class="chart-bar-row"><span>11A1</span><div class="chart-track"><div class="chart-fill group-a" style="width:${a/max*100}%"></div></div><b>${a}</b></div>
      <div class="chart-bar-row"><span>11A2</span><div class="chart-track"><div class="chart-fill group-b" style="width:${b/max*100}%"></div></div><b>${b}</b></div></div></div>`;
  }).join("");
}

async function boot(){
  const params=new URLSearchParams(location.search);
  const adminMode=params.has("admin"),dashboardMode=params.has("dashboard");
  try{
    if(!firebaseConfig.apiKey||firebaseConfig.apiKey.startsWith("DAN_"))throw new Error("Firebase chưa được cấu hình");
    app=initializeApp(firebaseConfig);auth=getAuth(app);db=getFirestore(app);
    if(dashboardMode){showOnly("dashboardView");await loadPublicDashboard();$("dashboardReloadButton").addEventListener("click",loadPublicDashboard);}
    else if(adminMode){
      showOnly("adminView");initAdminUI();
      onAuthStateChanged(auth,user=>{
        if(user?.email?.toLowerCase()===ADMIN_EMAIL.toLowerCase()){
          currentUser=user;$("adminLogin").classList.add("hidden");$("adminDashboard").classList.remove("hidden");
          $("adminIdentity").textContent="Đã đăng nhập: "+user.email;loadAdminData();makeQRs();
        }
      });
    }else{showOnly("studentView");await initStudent();}
    if("serviceWorker" in navigator)navigator.serviceWorker.register("./sw.js").catch(()=>{});
  }catch(e){console.warn(e);showOnly("setupView");}
}
boot();
