import jwt from "jsonwebtoken";
import { User, Class } from "./models.js";

export async function requireAuth(req, res, next) {
  try {
    const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (!token) return res.status(401).json({ message: "Please sign in." });
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(payload.sub).populate("assignedClasses", "_id name");
    if (!user || !user.active) return res.status(401).json({ message: "Account unavailable." });
    req.user = user;
    next();
  } catch {
    return res.status(401).json({ message: "Session expired. Please sign in again." });
  }
}
export function requireAdmin(req, res, next) {
  if (req.user?.role !== "admin") return res.status(403).json({ message: "Admin access required." });
  next();
}
export async function canAccessClass(user, classId) {
  if (user.role === "admin") return true;
  const ids = (user.assignedClasses || []).map(c => String(c._id || c));
  if (ids.includes(String(classId))) return true;
  const cls = await Class.findById(classId).select("teacherIds");
  return Boolean(cls?.teacherIds.some(id => String(id) === String(user._id)));
}
