import express, { Application, Request, Response } from "express";
import mongoose from "mongoose";
import { User } from "./models/user";
import bcrypt from "bcrypt";
import dotenv from "dotenv";
import jwt from "jsonwebtoken";

const app: Application = express();

// Configure env
dotenv.config();

// Check if JWT_SECRET is set
if (!process.env.JWT_SECRET) {
  console.error("JWT_SECRET is not set. Check your environment variables.");
  process.exit(1);
}

const JWT_SECRET = process.env.JWT_SECRET;

// Parser
app.use(express.json());
app.use(
  express.urlencoded({
    extended: true,
  })
);

// JWT middleware
app.use(async (req: Request, res: Response, next: Function) => {
  if (req.headers.authorization) {
    const token = req.headers.authorization.split(" ")[1];
    try {
      const user = jwt.verify(token, JWT_SECRET);
      (req as any).user = user;
    } catch (error) {
      console.error("Error verifying token:", error);
    }
  }
  next();
});

// Check server availability
app.get("/check", (req: Request, res: Response) => {
  // Return a 200 status if the server is available
  res.sendStatus(200);
});

// Declare The PORT
const PORT = process.env.PORT || 8001;
app.get("/", (req: Request, res: Response) => {
  res.send("Welcome to a better way to play!");
});

// Listen for the server on PORT
app.listen(PORT, async () => {
  console.log(`🗄️ Server Fire on http://localhost:${PORT}`);

  // Connect to Database
  try {
    const DATABASE_URL =
      process.env.MONGODB_URI || "mongodb://localhost:27017/OMHL";
    await mongoose.connect(DATABASE_URL);
    console.log("🛢️ Connected To Database");
  } catch (error) {
    console.log("⚠️ Error connecting to the database:", error);
    process.exit(1); // Exit the process
  }
});

// User API to register account
app.post("/auth/register", async (req: Request, res: Response) => {
  try {
    // Get user data from the request body
    const user = req.body;

    // Destructure the information from the user
    const { name, email, username, password } = user;

    // Check if the email already exists in the database
    const emailAlreadyExists = await User.findOne({
      email: email,
    });

    const usernameAlreadyExists = await User.findOne({
      username: username,
    });

    if (emailAlreadyExists) {
      return res.status(400).json({
        status: 400,
        message: "Email already in use",
      });
    }

    if (usernameAlreadyExists) {
      return res.status(400).json({
        status: 400,
        message: "Username already in use",
      });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const newUser = await User.create({
      name,
      email,
      username,
      password: hashedPassword,
    });

    const token = jwt.sign({ id: newUser._id }, JWT_SECRET);

    // Determine where to direct the user after registration
    const redirectPage =
      emailAlreadyExists || usernameAlreadyExists ? "Roster" : "Profile";

    return res.status(201).json({
      status: 201,
      success: true,
      message: "User created successfully",
      user: newUser,
      token,
      redirectPage,
    });
  } catch (error) {
    console.error("Error while registering user:", error);
    return res.status(500).json({
      status: 500,
      message: "Failed to create a new user. Please try again",
    });
  }
});

// User API to login
app.post("/auth/login", async (req: Request, res: Response) => {
  try {
    console.log("Login request received", req.body);
    const { username, password } = req.body;

    const user = await User.findOne({ username });

    if (!user) {
      return res.status(404).json({
        status: 404,
        message: "User not found",
      });
    }

    const passwordMatch = await bcrypt.compare(password, user.password);

    if (!passwordMatch) {
      return res.status(401).json({
        status: 401,
        message: "Incorrect password",
      });
    }

    const token = jwt.sign({ id: user._id }, JWT_SECRET);

    return res.status(200).json({
      status: 200,
      success: true,
      message: "Login successful",
      user,
      token,
    });
  } catch (error) {
    console.error("Error logging in:", error);
    return res.status(500).json({
      status: 500,
      message: "Failed to process the login request",
    });
  }
});

// User API to get all users
app.get("/users", async (req: Request, res: Response) => {
  try {
    const users = await User.find().select("-password");
    return res.status(200).json({
      status: 200,
      success: true,
      users,
    });
  } catch (error) {
    console.error("Error fetching users:", error);
    return res.status(500).json({
      status: 500,
      message: "Failed to fetch users",
    });
  }
});

// User API to get user data
app.get("/user/:id", async (req: Request, res: Response) => {
  try {
    const user = await User.findById(req.params.id).select("-password");

    if (!user) {
      return res.status(404).json({
        status: 404,
        message: "User not found",
      });
    }

    return res.status(200).json({
      status: 200,
      success: true,
      user,
    });
  } catch (error) {
    console.error("Error fetching user data:", error);
    return res.status(500).json({
      status: 500,
      message: "Failed to fetch user data",
    });
  }
});
