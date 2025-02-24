const express = require("express");
const sql = require("mssql");
const cors = require("cors");
const nodemailer = require("nodemailer");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(express.json());
app.use(cors());

// Database Configuration (use environment variables)
const dbConfig = {
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  server: process.env.DB_SERVER,
  database: "AkilamWebsite",
  options: {
    encrypt: false, // Set to true if using Azure
    trustServerCertificate: true, // Required for self-signed certificates
  },
};

// Nodemailer Configuration
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER, // Set in .env file
    pass: process.env.EMAIL_PASS, // Set in .env file
  },
});

// API to Handle Form Submission
app.post("/send-email", async (req, res) => {
  const { firstName, lastName, dob, mobile, email, message, course } = req.body;

  if (!firstName || !lastName || !dob || !mobile || !email) {
    return res
      .status(400)
      .json({ success: false, message: "Missing required fields" });
  }

  let pool;
  try {
    // Connect to SQL Server
    pool = await sql.connect(dbConfig);

    // Insert Data into the Registration Table
    const query = `
      INSERT INTO registration (firstName, lastName, email, mobileno, dob, dor, fromweb, message, course)
      VALUES (@firstName, @lastName, @email, @mobile, @dob, GETDATE(), 1, @message, @course)
    `;

    const request = pool.request();
    request.input("firstName", sql.VarChar, firstName);
    request.input("lastName", sql.VarChar, lastName);
    request.input("email", sql.VarChar, email);
    request.input("mobile", sql.VarChar, mobile);
    request.input("dob", sql.VarChar, dob);
    request.input("message", sql.VarChar, message);
    request.input("course", sql.VarChar, course || "No Course Selected");

    await request.query(query);

    // Send Email
  const mailOptions = {
    from: process.env.EMAIL_USER,
    to: email,
    subject: "🎉 Welcome to Akilam Education - Registration Confirmed!",
    html: `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 20px; border: 1px solid #ddd; border-radius: 10px; background-color: #f9f9f9;">
      <div style="text-align: center;">
        <img src="https://www.akilamtechnology.com/assets/img/AkilamTechmidlogo.png" alt="Akilam Education" style="max-width: 150px; margin-bottom: 20px;">
      </div>
      <h2 style="color: #ae3a94; text-align: center;">Welcome to Akilam Education, ${firstName}!</h2>
      <p style="color: #555; font-size: 16px;">Congratulations! You have successfully registered for <strong>${course}</strong> Course. We're excited to have you on board and look forward to helping you achieve your learning goals.</p>
      
      <p style="color: #555; font-size: 16px;">Here’s what you can expect:</p>
      <ul style="color: #555; font-size: 16px;">
        <li>Access to expert-led courses and materials</li>
        <li>Interactive learning experience</li>
        <li>Support from our dedicated team</li>
      </ul>

      <p style="color: #555; font-size: 16px;">If you have any questions or need assistance, feel free to reach out to us at <a href="mailto:support@akilameducation.com" style="color: #007bff; text-decoration: none;">support@akilameducation.com</a>.</p>

  

      <p style="color: #ae3a94; font-size: 14px; text-align: center; margin-top: 20px;">Best regards,<br><strong>Akilam Education</strong> (Akilam Technology LLP)</p>
    </div>
  `,
  };


    try {
      await transporter.sendMail(mailOptions);
    } catch (emailError) {
      console.error("Email Sending Error:", emailError);
    }

    res.status(200).json({
      success: true,
      message: "Data inserted and email sent successfully",
    });
  } catch (error) {
    console.error("Database Error:", error);
    res.status(500).json({ success: false, message: "Internal Server Error" });
  } finally {
    if (pool) {
      pool.close(); // Close the database connection
    }
  }
});

// Start Server
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
