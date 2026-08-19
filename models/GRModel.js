const db = require("../config/connection");
const TRANS = require("../config/transaction");
const { insertQuery, reusableQuery } = require("../helper/queryBuilder");
const { updatePOItemCompletion } = require("./POItemModel");
const { v4: uuidv4 } = require("uuid");
const Emailer = require("../service/mail");
const { updatePOCompletion } = require("./POModel");

const postGR = async (payload, itemPayload, invoiceFiles) => {
  const client = await db.connect();

  try {
    await client.query(TRANS.BEGIN);

    const [query, value] = insertQuery("goods_receipt", payload, "id_gr");

    console.log(query);

    const result = await client.query(query, value);
    const id_gr = result.rows[0].id_gr;

    for (const fileName of invoiceFiles || []) {
      await client.query(
        `
          INSERT INTO invoice_file (
            gr_id,
            invoice_file_name
          )
          VALUES ($1, $2)
        `,
        [id_gr, fileName],
      );
    }

    itemPayload = itemPayload.map((item) => {
      delete item.description;
      delete item.id_po;
      delete item.uom;

      return {
        ...item,
        id_gr_item: uuidv4(),
        id_gr,
      };
    });

    console.log("item payload", itemPayload);

    const itemInsert = itemPayload.map(({ is_complete, ...item }) => item);

    const [itemQuery, itemValue] = insertQuery(
      "goods_receipt_item",
      itemInsert,
    );

    console.log(itemQuery);

    await client.query(itemQuery, itemValue);

    const updateCompleteId = itemPayload
      .filter((item) => item.is_complete === true)
      .map((item) => item.id_po_item);

    await updatePOItemCompletion(client, updateCompleteId);

    await updatePOCompletion(client, payload.id_po);

    const Email = new Emailer();
    const emailResult = await Email.newGR(id_gr);

    console.log(emailResult);

    await client.query(TRANS.COMMIT);

    return id_gr;
  } catch (error) {
    console.log(error);

    await client.query(TRANS.ROLLBACK);

    throw error;
  } finally {
    client.release();
  }
};

const getGRByUser = async (id_user) => {
  const client = await db.connect();
  try {
    await client.query(TRANS.BEGIN);
    const result = await client.query(
      `
      SELECT 
        gr.id_po,
        gr.id_gr,
        gr.gr_date,
        po.po_date,
        (SUM(gri.unit_price * gri.qty) - gr.discount) *
          CASE
            WHEN gr.ppn = 0.10 THEN 1.10
            WHEN gr.ppn = 0.11 THEN 1.11
            ELSE 1.0
          END
        AS grand_total,
        c.company_name,
        v.vendor_name,
        gr.status
      FROM goods_receipt gr
      JOIN purchase_order po ON gr.id_po = po.id_po
      JOIN mst_company c ON po.id_company = c.id_company
      JOIN mst_vendor v ON po.id_vendor = v.id_vendor
      JOIN goods_receipt_item gri ON gr.id_gr = gri.id_gr
      WHERE po.id_user = $1
      GROUP BY gr.id_po, gr.id_gr, po.po_date, c.company_name, v.vendor_name
      ORDER BY
      CASE
        WHEN gr.status = 'pending' THEN 0
        ELSE 1
      END,
      gr.gr_date DESC
      `,
      [id_user],
    );
    await client.query(TRANS.COMMIT);
    return result.rows;
  } catch (error) {
    console.log(error);
    await client.query(TRANS.ROLLBACK);
    throw error;
  } finally {
    client.release();
  }
};

const getGRById = async (id_gr) => {
  const client = await db.connect();

  try {
    await client.query(TRANS.BEGIN);

    const result = await client.query(
      `
      SELECT
        gr.*,
        u.name AS approval_by,
        SUM(gri.unit_price * gri.qty) AS sub_total,
        (SUM(gri.unit_price * gri.qty) - gr.discount) *
          CASE
            WHEN gr.ppn = 0.10 THEN 1.10
            WHEN gr.ppn = 0.11 THEN 1.11
            ELSE 1.0
          END AS grand_total,
        po.id_company,
        po.id_vendor,
        po.po_date
      FROM goods_receipt gr
      JOIN purchase_order po
        ON po.id_po = gr.id_po
      JOIN goods_receipt_item gri
        ON gr.id_gr = gri.id_gr
      LEFT JOIN mst_user u
        ON gr.approval_by = u.id_user
      WHERE gr.id_gr = $1
      GROUP BY
        gr.id_gr,
        po.id_company,
        po.id_vendor,
        po.po_date,
        u.name
      `,
      [id_gr],
    );

    if (result.rows.length === 0) {
      throw new Error("GR not found");
    }

    const [companyResult, vendorResult, itemResult, invoiceResult] =
      await Promise.all([
        client.query(`SELECT * FROM mst_company WHERE id_company = $1`, [
          result.rows[0].id_company,
        ]),

        client.query(`SELECT * FROM mst_vendor WHERE id_vendor = $1`, [
          result.rows[0].id_vendor,
        ]),

        client.query(
          `
        SELECT
          gri.*,
          (gri.unit_price * gri.qty) AS amount,
          poi.uom,
          poi.description
        FROM goods_receipt_item gri
        JOIN purchase_order_item poi
          ON poi.id_po_item = gri.id_po_item
        WHERE gri.id_gr = $1
        ORDER BY poi.description ASC
        `,
          [id_gr],
        ),

        client.query(
          `
        SELECT
          id,
          invoice_file_name,
          created_at
        FROM invoice_file
        WHERE gr_id = $1
        ORDER BY created_at ASC
        `,
          [id_gr],
        ),
      ]);

    await client.query(TRANS.COMMIT);

    return {
      ...result.rows[0],
      company: companyResult.rows[0],
      vendor: vendorResult.rows[0],
      items: itemResult.rows,
      invoice_files: invoiceResult.rows,
    };
  } catch (error) {
    console.log(error);

    await client.query(TRANS.ROLLBACK);

    throw error;
  } finally {
    client.release();
  }
};

const getAllGR = async ({
  company_group = null,
  id_company = null,
  year = null,
  business_unit = null,
  company_name = null,
  page = 1,
  limit = 20,
} = {}) => {
  const client = await db.connect();

  try {
    await client.query(TRANS.BEGIN);

    // ==========================================
    // PAGINATION
    // ==========================================
    page = Math.max(Number(page) || 1, 1);
    limit = Math.max(Number(limit) || 20, 1);

    const offset = (page - 1) * limit;

    const conditions = [];
    const values = [];

    if (company_group) {
      values.push(company_group);
      conditions.push(`c.company_group = $${values.length}`);
    }

    if (id_company) {
      values.push(id_company);
      conditions.push(`c.id_company = $${values.length}`);
    }

    if (year) {
      values.push(year);
      conditions.push(`EXTRACT(YEAR FROM gr.gr_date) = $${values.length}`);
    }

    if (business_unit) {
      values.push(business_unit);

      conditions.push(`
        CASE
          WHEN LEFT(c.id_company, 2) = 'UP' THEN 'Plantation'
          WHEN LEFT(c.id_company, 2) = 'DW' THEN 'Downstream'
          WHEN LEFT(c.id_company, 2) = 'CG' THEN 'Cement'
          ELSE 'Other'
        END = $${values.length}
      `);
    }

    if (company_name && company_name !== "Semua Company") {
      values.push(company_name);
      conditions.push(`c.company_name = $${values.length}`);
    }

    const whereClause =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const businessUnitCase = `
      CASE
        WHEN LEFT(c.id_company, 2) = 'UP' THEN 'Plantation'
        WHEN LEFT(c.id_company, 2) = 'DW' THEN 'Downstream'
        WHEN LEFT(c.id_company, 2) = 'CG' THEN 'Cement'
        ELSE 'Other'
      END
    `;

    // ==========================================
    // PAGINATION VALUES
    // ==========================================
    const dataValues = [...values, limit, offset];

    const [status, businessUnit, company, amount, total, data] =
      await Promise.all([
        // ==========================================
        // STATUS
        // ==========================================
        client.query(
          `
            SELECT
              LOWER(gr.status) AS status,
              COUNT(*) AS count
            FROM goods_receipt gr
            JOIN purchase_order po
              ON gr.id_po = po.id_po
            JOIN mst_company c
              ON po.id_company = c.id_company
            ${whereClause}
            GROUP BY gr.status
          `,
          values,
        ),

        // ==========================================
        // BUSINESS UNIT SUMMARY
        // ==========================================
        client.query(
          `
            SELECT
              ${businessUnitCase} AS business_unit,

              COUNT(DISTINCT gr.id_gr) AS total_transaction,

              COALESCE(
                SUM(
                  (
                    item.total_item - COALESCE(gr.discount, 0)
                  )
                  *
                  CASE
                    WHEN gr.ppn = 0.10 THEN 1.10
                    WHEN gr.ppn = 0.11 THEN 1.11
                    ELSE 1.0
                  END
                ),
                0
              ) AS total_amount

            FROM goods_receipt gr

            JOIN purchase_order po
              ON gr.id_po = po.id_po

            JOIN mst_company c
              ON po.id_company = c.id_company

            JOIN (
              SELECT
                gri.id_gr,
                SUM(gri.unit_price * gri.qty) AS total_item
              FROM goods_receipt_item gri
              GROUP BY gri.id_gr
            ) item
              ON gr.id_gr = item.id_gr

            ${whereClause}

            GROUP BY ${businessUnitCase}

            ORDER BY
              CASE ${businessUnitCase}
                WHEN 'Plantation' THEN 1
                WHEN 'Downstream' THEN 2
                WHEN 'Cement' THEN 3
                ELSE 4
              END
          `,
          values,
        ),

        // ==========================================
        // COMPANY SUMMARY
        // ==========================================
        client.query(
          `
            SELECT
              c.id_company AS company_id,
              c.company_name,

              COUNT(DISTINCT gr.id_gr) AS total_transaction,

              COALESCE(
                SUM(
                  (
                    item.total_item - COALESCE(gr.discount, 0)
                  )
                  *
                  CASE
                    WHEN gr.ppn = 0.10 THEN 1.10
                    WHEN gr.ppn = 0.11 THEN 1.11
                    ELSE 1.0
                  END
                ),
                0
              ) AS grand_total

            FROM goods_receipt gr

            JOIN purchase_order po
              ON gr.id_po = po.id_po

            JOIN mst_company c
              ON po.id_company = c.id_company

            JOIN (
              SELECT
                gri.id_gr,
                SUM(gri.unit_price * gri.qty) AS total_item
              FROM goods_receipt_item gri
              GROUP BY gri.id_gr
            ) item
              ON gr.id_gr = item.id_gr

            ${whereClause}

            GROUP BY
              c.id_company,
              c.company_name

            ORDER BY c.company_name
          `,
          values,
        ),

        // ==========================================
        // TOTAL MONEY SPENT
        // ==========================================
        client.query(
          `
            SELECT
              COALESCE(SUM(t.grand_total), 0) AS sum
            FROM (
              SELECT
                gr.id_gr,

                (
                  SUM(gri.unit_price * gri.qty)
                  - COALESCE(gr.discount, 0)
                )
                *
                CASE
                  WHEN gr.ppn = 0.10 THEN 1.10
                  WHEN gr.ppn = 0.11 THEN 1.11
                  ELSE 1.0
                END AS grand_total

              FROM goods_receipt gr

              JOIN purchase_order po
                ON gr.id_po = po.id_po

              JOIN mst_company c
                ON po.id_company = c.id_company

              JOIN goods_receipt_item gri
                ON gr.id_gr = gri.id_gr

              ${whereClause}

              GROUP BY
                gr.id_gr,
                gr.discount,
                gr.ppn
            ) t
          `,
          values,
        ),

        // ==========================================
        // TOTAL RECORDS
        // ==========================================
        client.query(
          `
            SELECT COUNT(DISTINCT gr.id_gr) AS total
            FROM goods_receipt gr

            JOIN purchase_order po
              ON gr.id_po = po.id_po

            JOIN mst_company c
              ON po.id_company = c.id_company

            ${whereClause}
          `,
          values,
        ),

        // ==========================================
        // GR DATA
        // ==========================================
        client.query(
          `
            SELECT
              gr.id_po,
              gr.id_gr,
              gr.gr_date,
              po.po_date,

              (
                SUM(gri.unit_price * gri.qty)
                - COALESCE(gr.discount, 0)
              )
              *
              CASE
                WHEN gr.ppn = 0.10 THEN 1.10
                WHEN gr.ppn = 0.11 THEN 1.11
                ELSE 1.0
              END AS grand_total,

              c.id_company,
              c.company_name,
              c.company_group,

              ${businessUnitCase} AS business_unit,

              v.vendor_name,
              gr.status,
              u.name AS user_name

            FROM goods_receipt gr

            JOIN purchase_order po
              ON gr.id_po = po.id_po

            JOIN mst_company c
              ON po.id_company = c.id_company

            JOIN mst_vendor v
              ON po.id_vendor = v.id_vendor

            JOIN mst_user u
              ON po.id_user = u.id_user

            JOIN goods_receipt_item gri
              ON gr.id_gr = gri.id_gr

            ${whereClause}

            GROUP BY
              gr.id_po,
              gr.id_gr,
              gr.gr_date,
              po.po_date,
              c.id_company,
              c.company_name,
              c.company_group,
              v.vendor_name,
              gr.discount,
              gr.ppn,
              gr.status,
              u.name

            ORDER BY
              CASE
                WHEN gr.status = 'pending' THEN 0
                ELSE 1
              END,
              gr.gr_date DESC

            LIMIT $${dataValues.length - 1}
            OFFSET $${dataValues.length}
          `,
          dataValues,
        ),
      ]);

    await client.query(TRANS.COMMIT);

    const totalRecords = Number(total.rows[0]?.total || 0);
    const totalPages = Math.ceil(totalRecords / limit);

    return {
      status: status.rows,
      businessUnit: businessUnit.rows,
      company: company.rows,
      amount: amount.rows[0],
      data: data.rows,

      pagination: {
        page,
        limit,
        totalRecords,
        totalPages,
        hasNextPage: page < totalPages,
        hasPreviousPage: page > 1,
      },
    };
  } catch (error) {
    console.error(error);

    await client.query(TRANS.ROLLBACK);

    throw error;
  } finally {
    client.release();
  }
};

const getGRFilterOptions = async () => {
  const client = await db.connect();

  try {
    const [years, businessUnits] = await Promise.all([
      client.query(`
        SELECT DISTINCT
          EXTRACT(YEAR FROM gr.gr_date)::INTEGER AS year
        FROM goods_receipt gr
        WHERE gr.gr_date IS NOT NULL
        ORDER BY year DESC
      `),

      client.query(`
        SELECT DISTINCT
          CASE
            WHEN LEFT(c.id_company, 2) = 'UP' THEN 'Plantation'
            WHEN LEFT(c.id_company, 2) = 'DW' THEN 'Downstream'
            WHEN LEFT(c.id_company, 2) = 'CG' THEN 'Cement'
            ELSE 'Other'
          END AS business_unit
        FROM goods_receipt gr
        JOIN purchase_order po
          ON gr.id_po = po.id_po
        JOIN mst_company c
          ON po.id_company = c.id_company
        ORDER BY business_unit
      `),
    ]);

    return {
      years: years.rows.map((row) => row.year),
      businessUnits: businessUnits.rows.map((row) => row.business_unit),
    };
  } catch (error) {
    console.error(error);
    throw error;
  } finally {
    client.release();
  }
};

const GRApproval = async (payload, id_gr) => {
  const client = await db.connect();
  try {
    await client.query(TRANS.BEGIN);
    const Email = new Emailer();
    let result = null;
    if (payload.status === "approved") {
      const [update, user] = await Promise.all([
        client.query(
          `UPDATE goods_receipt
          SET status = $1, approval_by = $2, approval_date = $3
          WHERE id_gr = $4`,
          [payload.status, payload.id_user, payload.approval_date, id_gr],
        ),
        client.query(`SELECT name, email FROM mst_user WHERE id_user = $1`, [
          payload.id_user,
        ]),
      ]);
      result = update;
      const emailResult = await Email.GRApproved(id_gr, user.rows[0]);
      console.log(emailResult);
    } else if (payload.status === "rejected") {
      const [update, user] = await Promise.all([
        client.query(
          `UPDATE goods_receipt
          SET status = $1, approval_by = $2, approval_date = $3, reject_notes = $4
          WHERE id_gr = $5`,
          [
            payload.status,
            payload.id_user,
            payload.approval_date,
            payload.reject_notes,
            id_gr,
          ],
        ),
        client.query(`SELECT name, email FROM mst_user WHERE id_user = $1`, [
          payload.id_user,
        ]),
      ]);
      result = update;
      const emailResult = await Email.GRRejected(
        id_gr,
        user.rows[0],
        payload.reject_notes,
      );
      console.log(emailResult);
    }
    await client.query(TRANS.COMMIT);
    return result.rowCount;
  } catch (error) {
    console.log(error);
    await client.query(TRANS.ROLLBACK);
    throw error;
  } finally {
    client.release();
  }
};

module.exports = {
  postGR,
  getGRByUser,
  getGRById,
  GRApproval,
  getAllGR,
  getGRFilterOptions,
};
