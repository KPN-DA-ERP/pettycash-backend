const formidable = require("formidable");
const path = require("path");
const fs = require("fs");

const parseFormUpload = async (formData, options = {}) => {
  const form = new formidable.IncomingForm({
    uploadDir: options.uploadDir
      ? path.join(__dirname, `../uploads${options.uploadDir}`)
      : path.join(__dirname, "../uploads"),
    keepExtensions: true,
    maxFileSize: options.maxFileSize || 10 * 1024 * 1024,
    multiples: true,
  });

  try {
    const { fields, files } = await new Promise((resolve, reject) => {
      form.parse(formData, (error, fields, files) => {
        if (error) {
          return reject(error);
        }

        resolve({ fields, files });
      });
    });

    const payload = JSON.parse(fields.data);

    let uploadedFiles = files.files || [];

    if (!Array.isArray(uploadedFiles)) {
      uploadedFiles = [uploadedFiles];
    }

    if (uploadedFiles.length === 0) {
      throw new Error("No invoice file uploaded");
    }

    // Pisahkan nomor invoice berdasarkan "/"
    const invoiceNumbers = String(payload.invoice_num || "")
      .split("/")
      .map((value) => value.trim())
      .filter(Boolean);

    if (invoiceNumbers.length !== uploadedFiles.length) {
      throw new Error(
        `Jumlah invoice (${invoiceNumbers.length}) harus sama dengan jumlah file (${uploadedFiles.length})`,
      );
    }

    const invoiceFiles = [];

    for (let i = 0; i < uploadedFiles.length; i++) {
      const file = uploadedFiles[i];

      const invoiceNum = invoiceNumbers[i];

      // Invoice number boleh menggunakan "/",
      // tetapi "/" tidak boleh masuk ke nama file.
      const safeInvoiceNum = invoiceNum
        .replace(/[\\/:*?"<>|]/g, "-")
        .replace(/\s+/g, "_");

      const extension = path.extname(file.originalFilename);

      const newFilename = `${Date.now()}_${safeInvoiceNum}_${Math.random()
        .toString(36)
        .substring(2, 8)}${extension}`;

      const newFilePath = path.join(form.uploadDir, newFilename);

      await fs.promises.rename(file.filepath, newFilePath);

      invoiceFiles.push(newFilename);
    }

    return {
      payload,
      invoiceFiles,
    };
  } catch (error) {
    console.error(error);
    throw error;
  }
};

module.exports = { parseFormUpload };
