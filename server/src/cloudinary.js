import { v2 as cloudinary } from "cloudinary";

const configured = Boolean(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET);
if (configured) cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});
export async function uploadImageDataUrl(dataUrl) {
  if (!configured) throw new Error("Photo storage is not configured. Add Cloudinary credentials or use manual attendance.");
  const result = await cloudinary.uploader.upload(dataUrl, {
    folder: "madrasa-attendance/student-reference",
    resource_type: "image",
    transformation: [{ width: 700, height: 700, crop: "limit" }]
  });
  return result.secure_url;
}
