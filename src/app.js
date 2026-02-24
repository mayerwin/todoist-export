const path = require("path");

const express = require("express");
const cookieParser = require("cookie-parser");
const bodyParser = require("body-parser");
const morgan = require("morgan");
const logger = require("@darekkay/logger");
const axios = require("axios");
const csvParser = require("json-2-csv");

const config = require("./config");

const oauth2 = require("simple-oauth2").create({
  client: {
    id: config.client_id,
    secret: config.client_secret,
  },
  auth: {
    tokenHost: "https://app.todoist.com",
    tokenPath: "/oauth/access_token",
    authorizePath: "/oauth/authorize",
  },
  options: {
    authorizationMethod: "body",
  },
});

const IS_PRODUCTION = process.env.NODE_ENV === "production";
const COMPL_MAX_PAGE_SIZE = 200;
const FORMAT_SUFFIX_INCLUDE_ARCHIVED = "_all";

// Enable to debug Todoist API calls
const IS_AXIOS_TRACING_ACTIVE = false;

if (IS_AXIOS_TRACING_ACTIVE) {
  // Log axios requests
  axios.interceptors.request.use(function (config) {
    logger.log({
      url: config.url,
      method: config.method,
      data: config.data,
    });
    return config;
  });

  // Log axios response errors
  axios.interceptors.response.use(undefined, function (error) {
    logger.error({
      status: error.response?.status,
      statusText: error.response?.statusText,
      config: error.response?.config,
      data: error.response?.data,
    });
    return Promise.reject(error);
  });
}

const app = express();
const subdirectory = "/todoist-export";

app.set("views", path.join(__dirname, "views"));
app.set("view engine", "pug");
app.set("json spaces", 2); // prettify json output

const skipLogsFor = [
  "/js/",
  "/stylesheets/",
  "favicon.ico",
  "favicon-192.png",
  "manifest.json",
];

app.use(
  morgan(":method :url :status", {
    skip: function (request) {
      return skipLogsFor.some(
        (part) => request.originalUrl.indexOf(part) !== -1
      );
    },
  })
);
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(subdirectory, express.static(path.join(__dirname, "..", "public")));

app.get(`${subdirectory}/`, (req, res) => {
  res.render("index", {});
});

const callApi = async (api, parameters) => {
  const response = await axios({
    method: "post",
    headers: {
      Authorization: "Bearer " + parameters.token,
    },
    url: `https://api.todoist.com/api/v1/${api}`,
    data: parameters,
  });
  return response.data;
};

const callRestApi = async (path, token, params = {}) => {
  const url = new URL(`https://api.todoist.com/api/v1/${path}`);
  Object.entries(params).forEach(([key, val]) => {
    if (val !== null && val !== undefined) url.searchParams.set(key, val);
  });
  const response = await axios({
    method: "get",
    headers: { Authorization: "Bearer " + token },
    url: url.toString(),
  });
  return response.data;
};

const renderErrorPage = (res, message, error) => {
  logger.error((error && error.message ? error.message : error) || message);
  res.status((error && error.status) || 500);
  res.render("error", {
    message,
    error: IS_PRODUCTION ? undefined : error,
  });
};

app.post(`${subdirectory}/auth`, (req, res) => {
  var format = req.body.format || "json"; // csv vs. json
  if (req.body.archived) {
    format += FORMAT_SUFFIX_INCLUDE_ARCHIVED;
  }

  res.redirect(
    oauth2.authorizationCode.authorizeURL({
      scope: "data:read",
      state: format,
    })
  );
});

app.get(`${subdirectory}/export`, async (req, res) => {
  if (!req.query.code) {
    return renderErrorPage(res, "Parameter missing: code", { status: 400 });
  }

  try {
    const authResponse = await oauth2.authorizationCode.getToken({
      code: req.query.code,
    });

    const token = authResponse["access_token"];
    const format = req.query.format || "json";

    res.redirect(`${subdirectory}?token=${token}&format=${format}`);
  } catch (error) {
    renderErrorPage(res, error);
  }
});

const escapeCommas = (syncData) =>
  syncData.items.map((item) => ({
    ...item,
    labels: item.labels?.length > 0 ? `"${item.labels.join(",")}"` : null,
    content: `"${item.content.toString()}"`,
  }));

/* Convert project IDs into their corresponding names */
const convertProjectNames = (syncData) => {
  const projectNames = syncData.projects.reduce(
    (acc, project) => ({ ...acc, [project.id]: project.name }),
    {}
  );

  return syncData.items.map((item) => ({
    ...item,
    project_id: projectNames[item.project_id],
  }));
};

/* Convert user IDs into their corresponding names */
const convertUserNames = (syncData) => {
  const userNames = syncData.collaborators.reduce(
    (acc, collaborator) => ({
      ...acc,
      [collaborator.id]: collaborator.full_name,
    }),
    {}
  );

  return syncData.items.map((item) => ({
    ...item,
    assigned_by_uid: userNames[item.assigned_by_uid] || null,
    added_by_uid: userNames[item.added_by_uid] || null,
    user_id: userNames[item.user_id] || null,
  }));
};

const fetchCompleted = async function (token, cursor = null) {
  let page;
  try {
    const params = { limit: COMPL_MAX_PAGE_SIZE };
    if (cursor) params.cursor = cursor;

    page = await callRestApi("tasks/completed", token, params);
  } catch (error) {
    if (error.response) {
      logger.error({
        status: error.response.status,
        statusText: error.response.statusText,
        config: error.response.config,
        data: error.response.data,
      });
    } else {
      logger.error(error);
    }
    return { results: [] };
  }

  if (page.next_cursor) {
    const remainder = await fetchCompleted(token, page.next_cursor);
    return {
      results: (page.results || []).concat(remainder.results),
    };
  } else {
    return { results: page.results || [] };
  }
};

const exportData = async (res, token, format = "csv") => {
  const syncData = await callApi("sync", {
    token: token,
    sync_token: "*",
    resource_types: '["all"]',
  });

  if (syncData === undefined) {
    return renderErrorPage(res, "Could not fetch data from Todoist.");
  }

  // Fetch completed tasks (premium-only)
  if (format.includes(FORMAT_SUFFIX_INCLUDE_ARCHIVED)) {
    if (!syncData.user.is_premium) {
      return renderErrorPage(
        res,
        "Must be Todoist Premium to export archived items."
      );
    }
    format = format.replace(FORMAT_SUFFIX_INCLUDE_ARCHIVED, "");
    const completedData = await fetchCompleted(token);
    // Merge completed tasks into items so they appear in CSV and JSON exports
    syncData.completed = completedData; // keep for JSON export
    syncData.items = syncData.items.concat(completedData.results || []);
  }

  if (format === "json") {
    res.attachment("todoist.json");
    await res.json(syncData);
  } else if (format === "csv") {
    syncData.items = convertProjectNames(syncData);
    syncData.items = convertUserNames(syncData);
    syncData.items = escapeCommas(syncData);

    try {
      csvParser.json2csv(syncData.items, (error, csv) => {
        if (error) {
          return renderErrorPage(res, "CSV export error.", error);
        }
        res.attachment("todoist.csv");
        res.send(csv);
      });
    } catch (error) {
      return renderErrorPage(res, "CSV export error.", error);
    }
  }
};

app.get(`${subdirectory}/download`, async (req, res) => {
  try {
    await exportData(res, req.query.token, req.query.format);
  } catch (error) {
    return renderErrorPage(res, error.message || "Unexpected error.", error);
  }
});

app.get("*", (req, res) => {
  res.redirect(subdirectory);
});

/* Override default express error handling*/
app.use((error, req, res, next) => {
  renderErrorPage(res, error.message, error);
});

module.exports = app;
