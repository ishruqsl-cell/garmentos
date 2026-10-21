require("dotenv").config();
const express = require("express");
const session = require("express-session");
const PgSession = require("connect-pg-simple")(session);
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const ExcelJS = require("exceljs");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = Number(process.env.PORT || 10000);
const required = ["DATABASE_URL", "SESSION_SECRET", "ADMIN_USERNAME", "ADMIN_PASSWORD"];
for (const key of required) {
  if (!process.env[key]) { console.error(`Missing required environment variable: ${key}`); process.exit(1); }
}
if (process.env.SESSION_SECRET.length < 32) { console.error("SESSION_SECRET must be at least 32 characters."); process.exit(1); }

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : undefined,
  max: 8,
  connectionTimeoutMillis: 10000
});
const asyncRoute = fn => (req,res,next) => Promise.resolve(fn(req,res,next)).catch(next);
app.disable("x-powered-by");
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: false }));
app.use(session({
  store: new PgSession({ pool, tableName: "sara_sessions", createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", maxAge: 8 * 60 * 60 * 1000 }
}));

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_users (
      id BIGSERIAL PRIMARY KEY, username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('admin','editor','viewer')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS suppliers (
      id BIGSERIAL PRIMARY KEY, company TEXT NOT NULL, contact_name TEXT DEFAULT '',
      phone TEXT DEFAULT '', email TEXT DEFAULT '', address TEXT DEFAULT '',
      notes TEXT DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS work_orders (
      id BIGSERIAL PRIMARY KEY, wo_number TEXT UNIQUE NOT NULL, supplier_id BIGINT REFERENCES suppliers(id) ON DELETE SET NULL,
      supplier_company TEXT NOT NULL DEFAULT '', supplier_address TEXT DEFAULT '',
      issue_date DATE NOT NULL DEFAULT CURRENT_DATE, delivery_date DATE,
      department TEXT DEFAULT 'Value Chain', terms TEXT DEFAULT '', notes TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'Draft' CHECK (status IN ('Draft','Pending Approval','Approved','In Production','Completed','Archived')),
      merchandiser_name TEXT DEFAULT '', supplier_signatory TEXT DEFAULT '',
      management_approver TEXT DEFAULT '', created_by BIGINT REFERENCES app_users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS work_order_styles (
      id BIGSERIAL PRIMARY KEY, work_order_id BIGINT NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
      style_code TEXT NOT NULL DEFAULT '', description TEXT DEFAULT '', color TEXT DEFAULT '',
      quantity INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0),
      unit_price NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (unit_price >= 0),
      remarks TEXT DEFAULT '', sort_order INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_work_orders_updated ON work_orders(updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_work_orders_supplier ON work_orders(supplier_id);
    CREATE INDEX IF NOT EXISTS idx_styles_wo ON work_order_styles(work_order_id);
    CREATE INDEX IF NOT EXISTS idx_suppliers_company ON suppliers(company);
  `);
  const username = process.env.ADMIN_USERNAME.trim();
  const existing = await pool.query("SELECT id FROM app_users WHERE username=$1", [username]);
  if (!existing.rowCount) {
    const hash = await bcrypt.hash(process.env.ADMIN_PASSWORD, 12);
    await pool.query("INSERT INTO app_users(username,password_hash,role) VALUES($1,$2,'admin')", [username, hash]);
    console.log("Initial administrator account created.");
  }
}
const requireAuth = (req,res,next) => req.session.user ? next() : res.status(401).json({ error: "Please sign in." });
const requireRole = (...roles) => (req,res,next) => {
  if (!req.session.user) return res.status(401).json({error:"Please sign in."});
  if (!roles.includes(req.session.user.role)) return res.status(403).json({error:"You do not have permission for this action."});
  next();
};
const s = v => String(v ?? "").trim();
const n = v => { const x = Number(v); return Number.isFinite(x) && x >= 0 ? x : 0; };
const validDate = v => v && /^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? v : null;

app.get("/api/health", asyncRoute(async(req,res) => {
  await pool.query("SELECT 1");
  res.json({ ok:true, service:"SaRa FOB Work Order Desk", database:"connected" });
}));
app.get("/api/session", (req,res) => res.json({ user: req.session.user || null }));
app.post("/api/login", asyncRoute(async(req,res) => {
  const username = s(req.body.username), password = String(req.body.password || "");
  const r = await pool.query("SELECT id,username,password_hash,role FROM app_users WHERE username=$1", [username]);
  if (!r.rowCount || !(await bcrypt.compare(password, r.rows[0].password_hash))) return res.status(401).json({error:"Incorrect username or password."});
  req.session.regenerate(err => {
    if (err) return res.status(500).json({error:"Could not create session."});
    req.session.user = { id:r.rows[0].id, username:r.rows[0].username, role:r.rows[0].role };
    req.session.save(e => e ? res.status(500).json({error:"Could not save session."}) : res.json({user:req.session.user}));
  });
}));
app.post("/api/logout", (req,res) => req.session.destroy(() => { res.clearCookie("connect.sid"); res.json({ok:true}); }));
app.use("/api", (req,res,next) => ["/session","/login","/logout","/health"].includes(req.path) ? next() : requireAuth(req,res,next));

app.get("/api/dashboard", asyncRoute(async(req,res) => {
  const [wo,sup] = await Promise.all([
    pool.query("SELECT COUNT(*)::int AS total, COUNT(*) FILTER(WHERE status='Draft')::int AS drafts, COUNT(*) FILTER(WHERE status='Pending Approval')::int AS pending, COUNT(*) FILTER(WHERE status='Completed')::int AS completed FROM work_orders WHERE status <> 'Archived'"),
    pool.query("SELECT COUNT(*)::int AS total FROM suppliers")
  ]);
  res.json({workOrders:wo.rows[0], suppliers:sup.rows[0].total});
}));

app.get("/api/suppliers", asyncRoute(async(req,res) => {
  const q = `%${s(req.query.q)}%`;
  const r = await pool.query("SELECT * FROM suppliers WHERE company ILIKE $1 OR contact_name ILIKE $1 OR address ILIKE $1 ORDER BY company,id DESC LIMIT 500", [q]);
  res.json(r.rows);
}));
app.post("/api/suppliers", requireRole("admin","editor"), asyncRoute(async(req,res) => {
  const b=req.body;
  if (!s(b.company)) return res.status(400).json({error:"Supplier company is required."});
  const r=await pool.query("INSERT INTO suppliers(company,contact_name,phone,email,address,notes) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",
    [s(b.company),s(b.contact_name),s(b.phone),s(b.email),s(b.address),s(b.notes)]);
  res.status(201).json(r.rows[0]);
}));
app.put("/api/suppliers/:id", requireRole("admin","editor"), asyncRoute(async(req,res) => {
  const b=req.body;
  if (!s(b.company)) return res.status(400).json({error:"Supplier company is required."});
  const r=await pool.query("UPDATE suppliers SET company=$1,contact_name=$2,phone=$3,email=$4,address=$5,notes=$6,updated_at=NOW() WHERE id=$7 RETURNING *",
    [s(b.company),s(b.contact_name),s(b.phone),s(b.email),s(b.address),s(b.notes),req.params.id]);
  if(!r.rowCount) return res.status(404).json({error:"Supplier not found."}); res.json(r.rows[0]);
}));
app.delete("/api/suppliers/:id", requireRole("admin"), asyncRoute(async(req,res) => {
  await pool.query("DELETE FROM suppliers WHERE id=$1",[req.params.id]); res.json({ok:true});
}));

async function getWorkOrder(id) {
  const r=await pool.query("SELECT w.*, COALESCE((SELECT json_agg(st ORDER BY st.sort_order,st.id) FROM work_order_styles st WHERE st.work_order_id=w.id),'[]'::json) AS styles FROM work_orders w WHERE w.id=$1",[id]);
  return r.rows[0];
}
app.get("/api/work-orders", asyncRoute(async(req,res) => {
  const q=`%${s(req.query.q)}%`, archived=req.query.archived==="true";
  const r=await pool.query(`SELECT w.id,w.wo_number,w.supplier_company,w.issue_date,w.delivery_date,w.status,w.updated_at,
    COALESCE((SELECT SUM(st.quantity*st.unit_price) FROM work_order_styles st WHERE st.work_order_id=w.id),0)::numeric(14,2) AS total
    FROM work_orders w WHERE (w.status='Archived')=$1 AND (w.wo_number ILIKE $2 OR w.supplier_company ILIKE $2 OR w.status ILIKE $2)
    ORDER BY w.updated_at DESC LIMIT 500`,[archived,q]);
  res.json(r.rows);
}));
app.get("/api/work-orders/:id", asyncRoute(async(req,res) => {
  const w=await getWorkOrder(req.params.id); if(!w) return res.status(404).json({error:"Work order not found."}); res.json(w);
}));
app.post("/api/work-orders", requireRole("admin","editor"), asyncRoute(async(req,res) => {
  const b=req.body, styles=Array.isArray(b.styles)?b.styles:[];
  if(!s(b.wo_number) || !s(b.supplier_company)) return res.status(400).json({error:"Work order number and supplier company are required."});
  if(!styles.length) return res.status(400).json({error:"Add at least one style."});
  const client=await pool.connect();
  try {
    await client.query("BEGIN");
    const r=await client.query(`INSERT INTO work_orders(wo_number,supplier_id,supplier_company,supplier_address,issue_date,delivery_date,department,terms,notes,status,merchandiser_name,supplier_signatory,management_approver,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
      [s(b.wo_number),b.supplier_id||null,s(b.supplier_company),s(b.supplier_address),validDate(b.issue_date)||new Date().toISOString().slice(0,10),validDate(b.delivery_date),s(b.department)||"Value Chain",s(b.terms),s(b.notes),["Draft","Pending Approval","Approved","In Production","Completed"].includes(b.status)?b.status:"Draft",s(b.merchandiser_name),s(b.supplier_signatory),s(b.management_approver),req.session.user.id]);
    for(let i=0;i<styles.length;i++){
      const x=styles[i]; if(!s(x.style_code)) throw new Error("Each style row needs a style code.");
      await client.query("INSERT INTO work_order_styles(work_order_id,style_code,description,color,quantity,unit_price,remarks,sort_order) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
        [r.rows[0].id,s(x.style_code),s(x.description),s(x.color),Math.floor(n(x.quantity)),n(x.unit_price),s(x.remarks),i]);
    }
    await client.query("COMMIT"); res.status(201).json(await getWorkOrder(r.rows[0].id));
  } catch(e){await client.query("ROLLBACK"); if(e.code==="23505") return res.status(409).json({error:"That work order number already exists."}); if(e.message.includes("style row")) return res.status(400).json({error:e.message}); throw e;}
  finally{client.release();}
}));
app.put("/api/work-orders/:id", requireRole("admin","editor"), asyncRoute(async(req,res) => {
  const b=req.body, styles=Array.isArray(b.styles)?b.styles:[];
  if(!s(b.wo_number)||!s(b.supplier_company)||!styles.length) return res.status(400).json({error:"Work order number, supplier company and at least one style are required."});
  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    const upd=await client.query(`UPDATE work_orders SET wo_number=$1,supplier_id=$2,supplier_company=$3,supplier_address=$4,issue_date=$5,delivery_date=$6,department=$7,terms=$8,notes=$9,status=$10,merchandiser_name=$11,supplier_signatory=$12,management_approver=$13,updated_at=NOW() WHERE id=$14 RETURNING id`,
      [s(b.wo_number),b.supplier_id||null,s(b.supplier_company),s(b.supplier_address),validDate(b.issue_date)||new Date().toISOString().slice(0,10),validDate(b.delivery_date),s(b.department)||"Value Chain",s(b.terms),s(b.notes),["Draft","Pending Approval","Approved","In Production","Completed","Archived"].includes(b.status)?b.status:"Draft",s(b.merchandiser_name),s(b.supplier_signatory),s(b.management_approver),req.params.id]);
    if(!upd.rowCount){await client.query("ROLLBACK");return res.status(404).json({error:"Work order not found."});}
    await client.query("DELETE FROM work_order_styles WHERE work_order_id=$1",[req.params.id]);
    for(let i=0;i<styles.length;i++){const x=styles[i];if(!s(x.style_code))throw new Error("Each style row needs a style code.");
      await client.query("INSERT INTO work_order_styles(work_order_id,style_code,description,color,quantity,unit_price,remarks,sort_order) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
        [req.params.id,s(x.style_code),s(x.description),s(x.color),Math.floor(n(x.quantity)),n(x.unit_price),s(x.remarks),i]);}
    await client.query("COMMIT");res.json(await getWorkOrder(req.params.id));
  }catch(e){await client.query("ROLLBACK");if(e.code==="23505")return res.status(409).json({error:"That work order number already exists."});if(e.message.includes("style row"))return res.status(400).json({error:e.message});throw e;}finally{client.release();}
}));
app.post("/api/work-orders/:id/archive", requireRole("admin"), asyncRoute(async(req,res) => {
  const r=await pool.query("UPDATE work_orders SET status='Archived',updated_at=NOW() WHERE id=$1 RETURNING id",[req.params.id]);
  if(!r.rowCount)return res.status(404).json({error:"Work order not found."});res.json({ok:true});
}));
app.get("/api/work-orders/:id/excel", asyncRoute(async(req,res) => {
  const w=await getWorkOrder(req.params.id);if(!w)return res.status(404).json({error:"Work order not found."});
  const wb=new ExcelJS.Workbook(), ws=wb.addWorksheet("Work Order");
  ws.columns=[{width:7},{width:20},{width:30},{width:18},{width:13},{width:15},{width:16}];
  ws.mergeCells("A1:G1");ws.getCell("A1").value="SaRa Lifestyle Ltd. | FOB WORK ORDER";ws.getCell("A1").font={bold:true,size:16};ws.getCell("A1").alignment={horizontal:"center"};
  ws.addRow(["Work Order No.",w.wo_number,"Supplier",w.supplier_company,"Issue Date",String(w.issue_date).slice(0,10)]);
  ws.addRow(["Address",w.supplier_address,"Delivery Date",w.delivery_date?String(w.delivery_date).slice(0,10):"","Department",w.department]);
  ws.addRow([]);
  ws.addRow(["SL","Style Code","Description","Color","Quantity","Unit Price (BDT)","Total (BDT)"]);
  const header=ws.lastRow;header.font={bold:true};header.eachCell(c=>{c.border={top:{style:"thin"},bottom:{style:"thin"},left:{style:"thin"},right:{style:"thin"}};c.alignment={horizontal:"center",vertical:"middle",wrapText:true};});
  let total=0;
  w.styles.forEach((x,i)=>{const line=Number(x.quantity)*Number(x.unit_price);total+=line;ws.addRow([i+1,x.style_code,x.description,x.color,Number(x.quantity),Number(x.unit_price),line]);});
  ws.addRow(["","","","","","Grand Total",total]);
  ws.addRow([]);ws.addRow(["Terms & Conditions",w.terms]);ws.addRow(["Notes",w.notes]);ws.addRow([]);
  ws.addRow(["Assistant Merchandiser","Supplier Representative","Management Approval"]);
  ws.addRow([w.merchandiser_name,w.supplier_signatory,w.management_approver]);
  ws.eachRow(row=>row.eachCell(cell=>{cell.border={top:{style:"thin"},bottom:{style:"thin"},left:{style:"thin"},right:{style:"thin"}};cell.alignment={vertical:"middle",wrapText:true};}));
  res.setHeader("Content-Type","application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition",`attachment; filename="${w.wo_number.replace(/[^a-z0-9_-]/gi,"_")}.xlsx"`);
  await wb.xlsx.write(res);res.end();
}));

app.get("/api/users", requireRole("admin"), asyncRoute(async(req,res)=>{
 const r=await pool.query("SELECT id,username,role,created_at FROM app_users ORDER BY username");res.json(r.rows);
}));
app.post("/api/users", requireRole("admin"), asyncRoute(async(req,res)=>{
 const username=s(req.body.username),password=String(req.body.password||""),role=s(req.body.role);
 if(username.length<3||password.length<12||!["admin","editor","viewer"].includes(role))return res.status(400).json({error:"Use a username of at least 3 characters, password of at least 12 characters, and a valid role."});
 const hash=await bcrypt.hash(password,12);
 try{const r=await pool.query("INSERT INTO app_users(username,password_hash,role) VALUES($1,$2,$3) RETURNING id,username,role,created_at",[username,hash,role]);res.status(201).json(r.rows[0]);}
 catch(e){if(e.code==="23505")return res.status(409).json({error:"Username already exists."});throw e;}
}));
app.delete("/api/users/:id", requireRole("admin"), asyncRoute(async(req,res)=>{
 if(String(req.session.user.id)===String(req.params.id))return res.status(400).json({error:"You cannot delete your own account."});
 await pool.query("DELETE FROM app_users WHERE id=$1",[req.params.id]);res.json({ok:true});
}));

app.use(express.static(path.join(__dirname,"public"),{extensions:["html"]}));
app.get("*",(req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));
app.use((err,req,res,next)=>{console.error(err);if(res.headersSent)return next(err);res.status(500).json({error:"Unexpected server error. Check Render logs for details."});});
initDb().then(()=>app.listen(PORT,()=>console.log(`SaRa FOB Work Order Desk listening on ${PORT}`))).catch(err=>{console.error("Database initialization failed:",err);process.exit(1);});
