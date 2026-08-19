const { parseFormUpload } = require("../helper/fileUpload");
const {
  postGR,
  getGRByUser,
  getGRById,
  GRApproval,
  getAllGR,
  getGRFilterOptions,
} = require("../models/GRModel");
const { postGRItem } = require("../models/GRItemModel");
const { getRemainingItem } = require("../models/POItemModel");
const { getPOById } = require("../models/POModel");

const handleGetPOForGR = async (req, res) => {
  const id_po = decodeURIComponent(req.params.id_po);
  try {
    let result = await getPOById(id_po);
    result = {
      ...result,
      items: result.items.filter((item) => item.is_complete !== true),
    };
    res.status(200).send({
      message: `Success get PO: ${id_po}`,
      data: result,
    });
  } catch (error) {
    res.status(500).send({
      message: error.message,
    });
  }
};

const handlePostGR = async (req, res) => {
  try {
    let { payload, invoiceFiles } = await parseFormUpload(req, {
      uploadDir: "/invoice",
    });

    let itemPayload = payload.items.map(({ amount, ...rest }) => rest);

    delete payload.items;
    delete payload.sub_total;
    delete payload.grand_total;

    payload = {
      ...payload,
      id_gr:
        "CFM" + Math.floor(1000 + Math.random() * 9000) + "-" + payload.id_po,
      ppn: Number(payload.ppn || 0),
    };

    console.log("GR payload:", payload);
    console.log("Invoice files:", invoiceFiles);

    const id_gr = await postGR(payload, itemPayload, invoiceFiles);

    res.status(200).send({
      message: `Success create Order Confirmation: ${id_gr}`,
      id_gr,
    });
  } catch (error) {
    console.error(error);

    res.status(500).send({
      message: error.message,
    });
  }
};

const handleGetGRByUser = async (req, res) => {
  const id_user = req.params.id_user;
  try {
    const result = await getGRByUser(id_user);
    res.status(200).send({
      message: `Success get user GR: ${id_user}`,
      data: result,
    });
  } catch (error) {
    res.status(500).send({
      message: error.message,
    });
  }
};

const handleGetGRById = async (req, res) => {
  const id_gr = decodeURIComponent(req.params.id_gr);
  try {
    const result = await getGRById(id_gr);
    res.status(200).send({
      message: `Success get GR: ${id_gr}`,
      data: result,
    });
  } catch (error) {
    res.status(500).send({
      message: error.message,
    });
  }
};

const handleGetRemainingItem = async (req, res) => {
  try {
    const result = await getRemainingItem();
    res.status(200).send({
      message: `Success get remaining item`,
      data: result,
    });
  } catch (error) {
    res.status(500).send({
      message: error.message,
    });
  }
};

const handleGetAllGR = async (req, res) => {
  try {
    const {
      company_group = null,
      id_company = null,
      year = null,
      bu = null,
      company = null,
      page = 1,
      limit = 5,
    } = req.query;

    const result = await getAllGR({
      company_group,
      id_company,
      year,
      business_unit: bu,
      company_name: company,
      page,
      limit,
    });

    const {
      status,
      businessUnit,
      company: companyTotal,
      amount: moneySpent,
      data,
      pagination,
    } = result;

    const statusCount = status.reduce((accumulator, current) => {
      accumulator[current.status] = parseInt(current.count, 10);

      return accumulator;
    }, {});

    res.status(200).send({
      message: "Success get all GR",
      money_spent: moneySpent,
      status_count: statusCount,
      business_unit: businessUnit,
      company_total: companyTotal,
      data,
      pagination,
    });
  } catch (error) {
    console.error(error);

    res.status(500).send({
      message: error.message,
    });
  }
};

const handleGetGRFilterOptions = async (req, res) => {
  try {
    const data = await getGRFilterOptions();

    return res.status(200).send({
      message: "Success get GR filter options",
      data,
    });
  } catch (error) {
    console.error(error);

    return res.status(500).send({
      message: error.message,
    });
  }
};

const handleGRApproval = async (req, res) => {
  let payload = req.body;
  const id_gr = decodeURIComponent(req.params.id_gr);
  try {
    if (
      !payload.id_user ||
      !payload.status ||
      !payload.approval_date ||
      !id_gr
    ) {
      throw new Error("Bad Request");
    }
    const result = await GRApproval(payload, id_gr);
    res.status(200).send({
      message: `GR ${id_gr} ${payload.status}`,
    });
  } catch (error) {
    if (error.message === "Bad Request") {
      res.status(400).send({
        message: error.message,
      });
    } else {
      res.status(500).send({
        message: error.message,
      });
    }
  }
};

module.exports = {
  handlePostGR,
  handleGetGRByUser,
  handleGetRemainingItem,
  handleGetPOForGR,
  handleGetGRById,
  handleGRApproval,
  handleGetAllGR,
  handleGetGRFilterOptions
};
