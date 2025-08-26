const express = require("express");
const sql = require("mssql");
const cors = require("cors");
const nodemailer = require("nodemailer");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 8987;

/* -------------------- Middleware -------------------- */
app.use(express.json());
app.use(cors());

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Serve uploaded images statically
app.use("/uploads", express.static(uploadsDir));

/* -------------------- DB Config -------------------- */
const dbConfig = {
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  server: process.env.DB_SERVER,
  database: "AkilamWebsite",
  options: {
    encrypt: false, // set true if using Azure SQL
    trustServerCertificate: true,
  },
};

/* -------------------- Mailer -------------------- */
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

/* -------------------- Registration API -------------------- */
app.post("/send-email", async (req, res) => {
  const { firstName, lastName, dob, mobile, email, message, course } = req.body;

  if (!firstName || !lastName || !dob || !mobile || !email) {
    return res
      .status(400)
      .json({ success: false, message: "Missing required fields" });
  }

  let pool;
  try {
    pool = await sql.connect(dbConfig);

    const query = `
      INSERT INTO registration (firstName, lastName, email, mobileno, dob, dor, fromweb, message, course)
      VALUES (@firstName, @lastName, @email, @mobile, @dob, GETDATE(), 1, @message, @course)
    `;

    await pool
      .request()
      .input("firstName", sql.VarChar, firstName)
      .input("lastName", sql.VarChar, lastName)
      .input("email", sql.VarChar, email)
      .input("mobile", sql.VarChar, mobile)
      .input("dob", sql.VarChar, dob)
      .input("message", sql.VarChar, message)
      .input("course", sql.VarChar, course || "No Course Selected")
      .query(query);

    // Send confirmation email (best-effort)
    try {
      await transporter.sendMail({
        from: process.env.EMAIL_USER,
        to: email,
        subject: "🎉 Welcome to Akilam Technology - Registration Confirmed!",
        html: `<h3>Welcome ${firstName},</h3><p>You have successfully registered for <strong>${course}</strong>.</p>`,
      });
    } catch (emailError) {
      console.error("Email Sending Error:", emailError);
    }

    res
      .status(200)
      .json({
        success: true,
        message: "Data inserted and email sent successfully",
      });
  } catch (error) {
    console.error("Database Error (registration):", error);
    res.status(500).json({ success: false, message: "Internal Server Error" });
  } finally {
    if (pool) pool.close();
  }
});

/* -------------------- Category APIs -------------------- */
app.get("/api/categories", async (_req, res) => {
  try {
    const pool = await sql.connect(dbConfig);
    const result = await pool
      .request()
      .query("SELECT id, category_name FROM CourseCategory");
    res.json(result.recordset);
  } catch (error) {
    console.error("Error fetching categories:", error);
    res.status(500).send("Internal Server Error");
  }
});

app.post("/api/categories", async (req, res) => {
  const { category_name } = req.body;
  if (!category_name) {
    return res
      .status(400)
      .json({ success: false, message: "Category name is required" });
  }
  try {
    const pool = await sql.connect(dbConfig);
    await pool
      .request()
      .input("category_name", sql.NVarChar, category_name)
      .query(
        "INSERT INTO CourseCategory (category_name) VALUES (@category_name)"
      );
    res
      .status(201)
      .json({ success: true, message: "Category added successfully" });
  } catch (error) {
    console.error("Error inserting category:", error);
    res.status(500).send("Internal Server Error");
  }
});

/* -------------------- Coupon APIs -------------------- */
app.get("/api/couponvalues", async (_req, res) => {
  try {
    const pool = await sql.connect(dbConfig);
    const result = await pool
      .request()
      .query("SELECT id, discount, couponcode FROM couponvalues");
    res.json(result.recordset);
  } catch (error) {
    console.error("Error fetching coupons:", error);
    res.status(500).send("Internal Server Error");
  }
});

app.post("/api/couponvalues", async (req, res) => {
  const { discount, couponcode } = req.body;
  if (discount == null || !couponcode) {
    return res.status(400).json({ success: false, message: "Missing fields" });
  }
  try {
    const pool = await sql.connect(dbConfig);
    await pool
      .request()
      .input("discount", sql.Int, discount)
      .input("couponcode", sql.NVarChar, couponcode)
      .query(
        "INSERT INTO couponvalues (discount, couponcode) VALUES (@discount, @couponcode)"
      );
    res
      .status(201)
      .json({ success: true, message: "Coupon inserted successfully" });
  } catch (error) {
    console.error("Error inserting coupon:", error);
    res.status(500).send("Internal Server Error");
  }
});

/* -------------------- Course APIs -------------------- */
app.get("/api/course", async (_req, res) => {
  try {
    const pool = await sql.connect(dbConfig);
    const result = await pool.request().query(`
      SELECT id, course, courseimage, coursedetails, coursecouponid, courseduration, coursecategory
      FROM course
    `);
    res.json(result.recordset);
  } catch (error) {
    console.error("Error fetching courses:", error);
    res.status(500).send("Internal Server Error");
  }
});

/* -------------------- Multer (file upload) -------------------- */
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (_req, file, cb) =>
    cb(null, Date.now() + path.extname(file.originalname)),
});
const upload = multer({ storage });

app.post("/api/upload", upload.single("courseImage"), (req, res) => {
  try {
    if (!req.file) {
      console.error("❌ Multer did not receive file");
      return res.status(400).json({ error: "No file uploaded" });
    }
    // Recommend storing only the filename in DB
    const filename = req.file.filename;
    const url = `/uploads/${filename}`;
    console.log("✅ File uploaded:", filename);
    res.json({ filename, url, imagePath: url }); // imagePath kept for backward-compat
  } catch (err) {
    console.error("Upload error:", err);
    res.status(500).json({ error: "Upload failed" });
  }
});

/* -------------------- Add Course -------------------- */
app.post("/api/course", async (req, res) => {
  const {
    course,
    coursedetails,
    coursecouponid, // number or null
    courseduration,
    coursecategory, // number or null (ID)
    courseimage, // recommend sending the filename only
  } = req.body;

  // Basic validation
  if (!course)
    return res
      .status(400)
      .json({ success: false, message: "course is required" });

  // Normalize IDs to integers (or null)
  const couponId = Number.isFinite(Number(coursecouponid))
    ? Number(coursecouponid)
    : null;
  const categoryId = Number.isFinite(Number(coursecategory))
    ? Number(coursecategory)
    : null;

  try {
    const pool = await sql.connect(dbConfig);
    await pool
      .request()
      .input("course", sql.NVarChar, course)
      .input("coursedetails", sql.NVarChar, coursedetails || null)
      .input("coursecouponid", sql.Int, couponId)
      .input("courseduration", sql.NVarChar, courseduration || null)
      .input("coursecategory", sql.Int, categoryId) // ✅ Int for FK ID
      .input("courseimage", sql.NVarChar, courseimage || null) // store filename or url; your choice
      .query(`
        INSERT INTO course (course, coursedetails, coursecouponid, courseduration, coursecategory, courseimage)
        VALUES (@course, @coursedetails, @coursecouponid, @courseduration, @coursecategory, @courseimage)
      `);

    res.json({ success: true, message: "✅ Course added successfully" });
  } catch (error) {
    console.error("Error inserting course:", error);
    res.status(500).json({ success: false, error: "Database error" });
  }
});

app.get("/api/courses", async (req, res) => {
  try {
    const pool = await sql.connect(dbConfig);
    const result = await pool.request().query(`
SELECT 
    c.id,
    c.course,
    c.courseimage,
    c.coursedetails,
    c.coursecouponid,
    c.courseduration,
    cc.category_name AS categoryname
FROM [AkilamWebsite].[dbo].[course] c
LEFT JOIN [AkilamWebsite].[dbo].[CourseCategory] cc
    ON TRY_CAST(c.coursecategory AS INT) = cc.id
ORDER BY c.id;

    `);
    res.json(result.recordset);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server Error" });
  }
});


/* -------------------- Start Server -------------------- */
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Server running at http://0.0.0.0:${PORT}`);
});
