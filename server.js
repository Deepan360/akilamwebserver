const express = require("express");
const sql = require("mssql");
const cors = require("cors");
const nodemailer = require("nodemailer");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
require("dotenv").config();
const Razorpay = require("razorpay");
const crypto = require("crypto");



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

/* -------------------- Razorpay -------------------- */
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});


/* -------------------- 1. Register API -------------------- */
app.post("/api/register", async (req, res) => {
  const { firstName, lastName, dob, mobile, email, message, courseId, couponCode } = req.body;

  if (!firstName || !lastName || !dob || !mobile || !email || !courseId) {
    return res.status(400).json({ success: false, message: "Missing required fields" });
  }

  let pool;
  try {
    pool = await sql.connect(dbConfig);

    // Get course fee
    const courseResult = await pool.request()
      .input("courseId", sql.Int, courseId)
      .query("SELECT course, coursefee FROM course WHERE id = @courseId");

    if (courseResult.recordset.length === 0) {
      return res.status(404).json({ success: false, message: "Invalid course selected" });
    }

    let { course, coursefee } = courseResult.recordset[0];

    // Apply coupon
    if (couponCode) {
      const couponResult = await pool.request()
        .input("couponCode", sql.VarChar, couponCode)
        .query("SELECT discount, start_date, end_date FROM couponvalues WHERE couponcode=@couponCode");

      if (couponResult.recordset.length > 0) {
        const coupon = couponResult.recordset[0];
        const now = new Date();
        if (now >= coupon.start_date && now <= coupon.end_date) {
          coursefee = coursefee - (coursefee * coupon.discount) / 100;
        }
      }
    }

    // Insert registration (Pending)
    const insertResult = await pool
      .request()
      .input("firstName", sql.VarChar, firstName)
      .input("lastName", sql.VarChar, lastName)
      .input("email", sql.VarChar, email)
      .input("mobile", sql.VarChar, mobile)
      .input("dob", sql.VarChar, dob)
      .input("message", sql.VarChar, message || "")
      .input("course", sql.VarChar, course)
      .input("amount", sql.Int, coursefee).query(`
        INSERT INTO registration (firstName, lastName, email, mobileno, dob, dor, fromweb, message, course, amount, payment_status)
        OUTPUT INSERTED.id
        VALUES (@firstName, @lastName, @email, @mobile, @dob, GETDATE(), 1, @message, @course, @amount, 'Pending')
      `);

    const registrationId = insertResult.recordset[0].id;

    res.json({ success: true, registrationId, coursefee });
  } catch (err) {
    console.error("Error registering:", err);
    res.status(500).json({ success: false, message: "Internal Server Error" });
  } finally {
    if (pool) pool.close();
  }
});

/* -------------------- 2. Create Razorpay Order -------------------- */
app.post("/api/create-order", async (req, res) => {
  const { registrationId } = req.body;

  if (!registrationId) {
    return res.status(400).json({ success: false, message: "Missing registrationId" });
  }

  let pool;
  try {
    pool = await sql.connect(dbConfig);

    const regResult = await pool.request()
      .input("id", sql.Int, registrationId)
      .query("SELECT course, amount FROM registration WHERE id=@id");

    if (regResult.recordset.length === 0) {
      return res.status(404).json({ success: false, message: "Registration not found" });
    }

    const { course, amount } = regResult.recordset[0];

    const order = await razorpay.orders.create({
      amount: Math.round(amount * 100),
      currency: "INR",
      receipt: `reg_${registrationId}`,
      notes: { registrationId, course },
    });

    await pool.request()
      .input("razorpay_order_id", sql.VarChar, order.id)
      .input("id", sql.Int, registrationId)
      .query("UPDATE registration SET razorpay_order_id=@razorpay_order_id WHERE id=@id");

    res.json({ success: true, orderId: order.id, amount: order.amount, currency: order.currency });
  } catch (err) {
    console.error("Error creating order:", err);
    console.log("Razorpay ID:", process.env.RAZORPAY_KEY_ID);
    console.log(
      "Razorpay Secret:",
      process.env.RAZORPAY_KEY_SECRET ? "Loaded" : "Missing"
    );

    res.status(500).json({ success: false, message: "Internal Server Error" });
  } finally {
    if (pool) pool.close();
  }
});


/* -------------------- 3. Verify Payment + Send Email -------------------- */
app.post("/api/verify-payment", async (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } =
    req.body;

  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    return res
      .status(400)
      .json({ success: false, message: "Missing payment fields" });
  }

  try {
    const body = razorpay_order_id + "|" + razorpay_payment_id;
    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(body.toString())
      .digest("hex");

    let status = "Failed";
    if (expectedSignature === razorpay_signature) {
      status = "Success";
    }

    const pool = await sql.connect(dbConfig);
    const updateResult = await pool
      .request()
      .input("razorpay_payment_id", sql.VarChar, razorpay_payment_id)
      .input("payment_status", sql.VarChar, status)
      .input("razorpay_order_id", sql.VarChar, razorpay_order_id).query(`
        UPDATE registration 
        SET razorpay_payment_id=@razorpay_payment_id, payment_status=@payment_status
        OUTPUT INSERTED.*
        WHERE razorpay_order_id=@razorpay_order_id
      `);

    const reg = updateResult.recordset[0];

    if (status === "Success" && reg) {
      // Send confirmation email with template
      await transporter.sendMail({
        from: process.env.EMAIL_USER,
        to: reg.email,
        subject: "🎉 Welcome to Akilam Education - Registration Confirmed!",
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 20px; border: 1px solid #ddd; border-radius: 10px; background-color: #f9f9f9;">
            <div style="text-align: center;">
              <img src="https://www.akilamtechnology.com/AkilamTechmidlogo.png" alt="Akilam Education" style="max-width: 150px; margin-bottom: 20px;">
            </div>
            <h2 style="color: #ae3a94; text-align: center;">Welcome to Akilam Education, ${reg.firstName}!</h2>
            <p style="color: #555; font-size: 16px;">Congratulations! You have successfully registered for <strong>${reg.course}</strong> Course. We're excited to have you on board and look forward to helping you achieve your learning goals.</p>
            <p style="color: #555; font-size: 16px;">If you have any questions, feel free to reach out at <a href="mailto:support@akilameducation.com" style="color: #007bff;">support@akilameducation.com</a>.</p>
            <p style="color: #ae3a94; font-size: 14px; text-align: center; margin-top: 20px;">Best regards,<br><strong>Akilam Education</strong> (Akilam Technology LLP)</p>
          </div>
        `,
      });
    }

    res.json({ success: status === "Success", message: `Payment ${status}` });
  } catch (err) {
    console.error("Error verifying payment:", err);
    res.status(500).json({ success: false, message: "Internal Server Error" });
  }
});


app.post("/api/validate-coupon", async (req, res) => {
  const { couponCode, courseFee } = req.body;

  try {
    const pool = await sql.connect(dbConfig);
    const result = await pool
      .request()
      .input("couponCode", sql.VarChar, couponCode).query(`
        SELECT id, discount, start_date, end_date
        FROM [AkilamWebsite].[dbo].[couponvalues]
        WHERE couponcode = @couponCode
      `);

    if (result.recordset.length === 0) {
      return res.json({ valid: false, message: "Invalid coupon" });
    }

    const coupon = result.recordset[0];
    const now = new Date();

    if (now < coupon.start_date || now > coupon.end_date) {
      return res.json({ valid: false, message: "Coupon expired" });
    }

    // Apply discount
    const discountAmount = (courseFee * coupon.discount) / 100;
    const finalAmount = Math.max(courseFee - discountAmount, 0);

    res.json({
      valid: true,
      discount: coupon.discount,
      finalAmount,
      message: `Coupon applied: ${coupon.discount}% OFF`,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ valid: false, message: "Server error" });
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


app.post("/api/applyCoupon", async (req, res) => {
  const { courseId, couponCode } = req.body;
  try {
    const pool = await sql.connect(dbConfig);

    // Get course fee
    const courseResult = await pool
      .request()
      .input("courseId", sql.Int, courseId)
      .query("SELECT coursefee FROM course WHERE id = @courseId");

    if (courseResult.recordset.length === 0) {
      return res.status(404).json({ message: "Course not found" });
    }

    const courseFee = courseResult.recordset[0].coursefee;

    // Get coupon discount
    const couponResult = await pool
      .request()
      .input("couponCode", sql.VarChar, couponCode)
      .query(
        "SELECT discount FROM couponvalues WHERE couponcode = @couponCode"
      );

    if (couponResult.recordset.length === 0) {
      return res.status(400).json({ message: "Invalid coupon" });
    }

    const discount = couponResult.recordset[0].discount;

    // Apply discount
    const discountedFee = courseFee - (courseFee * discount) / 100;

    res.json({ courseId, couponCode, originalFee: courseFee, discountedFee });
  } catch (error) {
    console.error("Error applying coupon:", error);
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
    coursefee, // optional, placeholder for future
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
      .input("coursefee", sql.Decimal, coursefee || null) // placeholder if needed
      .query(`
        INSERT INTO course (course, coursedetails, coursecouponid, courseduration, coursecategory, courseimage, coursefee)
        VALUES (@course, @coursedetails, @coursecouponid, @courseduration, @coursecategory, @courseimage, @coursefee)
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
    c.coursefee,
    cc.category_name AS categoryname
FROM [AkilamWebsite].[dbo].[course] c
LEFT JOIN [AkilamWebsite].[dbo].[CourseCategory] cc
    ON TRY_CAST(c.coursecategory AS INT) = cc.id
ORDER BY 
    CASE WHEN cc.is_top = 1 THEN 0 ELSE 1 END, -- top courses first
    c.id ASC; -- then ascending by id


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
