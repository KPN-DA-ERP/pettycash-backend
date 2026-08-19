const express = require("express");
const {
  handlePostGR,
  handleGetGRByUser,
  handleGetRemainingItem,
  handleGetPOForGR,
  handleGetGRById,
  handleGRApproval,
  handleGetAllGR,
  handleGetGRFilterOptions,
} = require("../controllers/GRController");
const { isAdmin } = require("../middleware/auth");
const router = express.Router();

router.post("/", handlePostGR);
router.get("/", handleGetAllGR);
router.get("/filter-options", handleGetGRFilterOptions);
router.patch("/approval/:id_gr", handleGRApproval);
router.get("/user/:id_user", handleGetGRByUser);
router.get("/remaining", handleGetRemainingItem);
router.get("/po/:id_po", handleGetPOForGR);
router.get("/:id_gr", handleGetGRById);

module.exports = router;
