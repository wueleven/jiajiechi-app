// 云函数 syncRecord - 同步记录管理
const cloud = require("wx-server-sdk");

cloud.init({ env: "cloud1-d8gyv2pt7517e6c31" });
const db = cloud.database();
const _ = db.command;

/**
 * 主入口
 */
exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext();
  const { action } = event;

  try {
    switch (action) {
      case "getRecords":
        return await getRecords(OPENID, event);
      case "createRecord":
        return await createRecord(OPENID, event);
      case "updateRecord":
        return await updateRecord(OPENID, event);
      case "deleteRecord":
        return await deleteRecord(OPENID, event);
      case "getStats":
        return await getStats(OPENID);
      default:
        return { success: false, message: "未知操作" };
    }
  } catch (err) {
    console.error("syncRecord error:", err);
    return { success: false, message: err.message || "服务器错误" };
  }
};

/**
 * 获取同步记录列表（分页）
 */
async function getRecords(openid, event) {
  const { page = 0, pageSize = 20, direction, status } = event;

  try {
    let query = db.collection("syncRecords").where({ openid });

    // 可选过滤条件
    if (direction) {
      query = db.collection("syncRecords").where({ openid, direction });
    }
    if (status) {
      query = db.collection("syncRecords").where({ openid, status });
    }

    const countRes = await query.count();
    const total = countRes.total;

    const recordsRes = await query
      .orderBy("createdAt", "desc")
      .skip(page * pageSize)
      .limit(pageSize)
      .get();

    return {
      success: true,
      data: recordsRes.data,
      total,
      page,
      pageSize,
      hasMore: (page + 1) * pageSize < total,
    };
  } catch (err) {
    console.error("getRecords error:", err);
    return { success: false, message: "获取记录失败" };
  }
}

/**
 * 创建同步记录
 */
async function createRecord(openid, event) {
  const { direction, activityId, activityName, activityTime, status = "pending" } = event;

  if (!direction || !activityId) {
    return { success: false, message: "参数不完整" };
  }

  try {
    const res = await db.collection("syncRecords").add({
      data: {
        openid,
        direction,
        activityId: String(activityId),
        activityName: activityName || "未知活动",
        activityTime: activityTime || "",
        status,
        errorMsg: "",
        createdAt: new Date().toLocaleString("zh-CN"),
        updatedAt: new Date(),
      },
    });

    return {
      success: true,
      recordId: res._id,
    };
  } catch (err) {
    console.error("createRecord error:", err);
    return { success: false, message: "创建记录失败" };
  }
}

/**
 * 更新同步记录
 */
async function updateRecord(openid, event) {
  const { recordId, status, errorMsg } = event;

  if (!recordId || !status) {
    return { success: false, message: "参数不完整" };
  }

  try {
    const updateData = {
      status,
      updatedAt: new Date().toLocaleString("zh-CN"),
    };

    if (errorMsg) {
      updateData.errorMsg = errorMsg;
    }

    await db
      .collection("syncRecords")
      .doc(recordId)
      .update({ data: updateData });

    return { success: true };
  } catch (err) {
    console.error("updateRecord error:", err);
    return { success: false, message: "更新记录失败" };
  }
}

/**
 * 删除同步记录
 */
async function deleteRecord(openid, event) {
  const { recordId } = event;

  if (!recordId) {
    return { success: false, message: "缺少记录ID" };
  }

  try {
    await db.collection("syncRecords").doc(recordId).remove();
    return { success: true };
  } catch (err) {
    console.error("deleteRecord error:", err);
    return { success: false, message: "删除记录失败" };
  }
}

/**
 * 获取同步统计信息
 */
async function getStats(openid) {
  try {
    const allRecords = await db
      .collection("syncRecords")
      .where({ openid })
      .get();

    const stats = {
      total: allRecords.data.length,
      success: allRecords.data.filter((r) => r.status === "success").length,
      failed: allRecords.data.filter((r) => r.status === "failed").length,
      pending: allRecords.data.filter((r) => r.status === "pending" || r.status === "syncing").length,
      byDirection: {
        garminCnToGarminCom: allRecords.data.filter(
          (r) => r.direction === "garminCnToGarminCom" && r.status === "success"
        ).length,
        garminComToGarminCn: allRecords.data.filter(
          (r) => r.direction === "garminComToGarminCn" && r.status === "success"
        ).length,
        garminCnToCoros: allRecords.data.filter(
          (r) => r.direction === "garminCnToCoros" && r.status === "success"
        ).length,
        garminComToCoros: allRecords.data.filter(
          (r) => r.direction === "garminComToCoros" && r.status === "success"
        ).length,
      },
    };

    return { success: true, data: stats };
  } catch (err) {
    console.error("getStats error:", err);
    return { success: false, message: "获取统计失败" };
  }
}
