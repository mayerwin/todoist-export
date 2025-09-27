'use strict';

module.exports = {
  // Render, Railway, Heroku, etc. inject PORT automatically
  port: process.env.PORT || 3000,

  // OAuth credentials — set them as environment variables in your host
  client_id: process.env.TODOIST_CLIENTID,
  client_secret: process.env.TODOIST_CLIENTSECRET,
};
