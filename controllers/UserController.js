const { v4: uuidv4 } = require("uuid");
const { hashPassword } = require("../helper/auth/password");
const {
  registerUser,
  verifyUser,
  loginUser,
  reqResetPassword,
  resetPassword,
  getNewToken,
} = require("../models/UserModel");
const jwt = require("jsonwebtoken");
const emailTemplate = require("../helper/emailTemplate");
const { validateOTP } = require("../helper/auth/OTP");

const handleLoginUser = async (req, res) => {
  const emailOrUname = req.body.username;
  const password = req.body.password;

  try {
    const { data, accessToken, refreshToken } = await loginUser(
      emailOrUname,
      password,
    );

    res.cookie("refresh_token", refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 30 * 24 * 60 * 60 * 1000,
    });

    return res.status(200).send({
      message: `Success sign in, welcome ${data.name}`,
      data: {
        name: data.name,
        username: data.username,
        email: data.email,
        id_user: data.id_user,
        id_role: data.id_role,
        access_token: accessToken,
      },
    });
  } catch (error) {
    if (
      error.message === "Invalid Password" ||
      error.message === "User Not Found"
    ) {
      return res.status(400).send({
        message: error.message,
      });
    }

    return res.status(500).send({
      message: error.message,
    });
  }
};

const handleRegisterUser = async (req, res) => {
  const email = req.body.email;
  const username = req.body.username;
  const password = await hashPassword(req.body.password);
  let id_role;
  switch (req.body.role) {
    case "user":
      id_role = "IaKgzAxkTeBRQlFVaVphGMa8etPpum37y56IeS9WBPE=";
      break;
    case "finance":
      id_role = "VOSZYnFCfVdxm11N95Q9PtY8qVL+jrHzjYs6BAEQ8TA=";
      break;
    default:
      id_role = "IaKgzAxkTeBRQlFVaVphGMa8etPpum37y56IeS9WBPE=";
  }

  const role = req.body.role;
  const payload = {
    name: req.body.name,
    username: username,
    password: password,
    email: email,
    id_user: uuidv4(),
    id_role: id_role,
  };

  try {
    const result = await registerUser(payload, role);
    res.status(200).send({
      message: "User registered, please wait for verification",
    });
  } catch (error) {
    res.status(500).send({
      message: error.message,
    });
  }
};

const handleVerifyUser = async (req, res) => {
  const id_user = req.params.id_user;
  const verify = req.query.verify === "true" ? true : false;
  const token = req.query.token;

  try {
    if (!token) throw new Error("Token Not Provided");
    const result = await verifyUser(id_user, verify, token);

    const verifyRes = emailTemplate(`
      <h1>User Verified</h1>
      <p>You can close this tab.</p>
    `);

    const rejectRes = emailTemplate(`
      <h1>User Rejected</h1>
      <p>You can close this tab.</p>
    `);

    res.set("Content-Type", "text/html");
    res.status(200).send(Buffer.from(verify ? verifyRes : rejectRes));
  } catch (error) {
    res.status(500).send({
      message: error.message,
    });
  }
};

const handleReqResetPassword = async (req, res) => {
  const email = req.body.email;
  if (!email) {
    return res.status(400).send({
      message: "Email is required",
    });
  }
  try {
    await reqResetPassword(email);
    return res.status(200).send({
      message: "OTP sent, please check your email address",
    });
  } catch (error) {
    console.log(error);
    return res.status(500).send({
      message: error.message,
    });
  }
};

const handleVerifyResetPassword = async (req, res) => {
  const email = req.body.email;
  const otpInput = req.body.otpInput;
  if (!email || !otpInput) {
    return res.status(400).send({
      message: "Bad Request",
    });
  }
  try {
    const validate = await validateOTP(otpInput, email);
    const sessionToken = jwt.sign({ email: email }, process.env.SECRETJWT, {
      expiresIn: "5m",
    });
    res.cookie("resetpwdSess", sessionToken, {
      httpOnly: true,
      sameSite: false,
      secure: true,
    });
    return res.status(200).send({
      message: "OTP Verified",
    });
  } catch (error) {
    console.error(error);
    return res.status(500).send({
      message: error.message,
    });
  }
};

const handleResetPassword = async (req, res) => {
  const session = req.cookies.resetpwdSess;
  const newPass = req.body.newPass;
  const email = req.body.email;
  try {
    const validateSession = jwt.verify(session, process.env.SECRETJWT);
    await resetPassword(newPass, email);
    return res.status(200).send({
      message: "Password has reset",
    });
  } catch (error) {
    if (error?.name == "TokenExpiredError") {
      return res.status(403).send("Session Expired");
    } else if (error?.name == "JsonWebTokenError") {
      return res.status(403).send("Invalid Session");
    } else {
      return res.status(500).send(error.message);
    }
  }
};

const refreshAccessToken = async (req, res) => {
  const refreshToken = req.cookies?.refresh_token;

  if (!refreshToken) {
    return res.status(403).send({
      message: "Refresh token not found",
    });
  }

  try {
    const token = await getNewToken(refreshToken);

    return res.status(200).send({
      access_token: token,
    });
  } catch (error) {
    console.error(error);

    if (error.name === "TokenExpiredError") {
      res.clearCookie("refresh_token");

      return res.status(403).send({
        message: "Refresh Token Expired. Logging out.",
      });
    }

    if (error.name === "JsonWebTokenError") {
      res.clearCookie("refresh_token");

      return res.status(403).send({
        message: "Invalid Refresh Token",
      });
    }

    return res.status(500).send({
      message: error.message,
    });
  }
};

module.exports = {
  handleRegisterUser,
  handleVerifyUser,
  handleLoginUser,
  handleReqResetPassword,
  handleVerifyResetPassword,
  handleResetPassword,
  refreshAccessToken,
};
