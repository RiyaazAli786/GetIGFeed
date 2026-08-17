'use strict';

/**
 * fastdl — self-contained module for the FastDL worker-hub downloader integration.
 */

const routes = require('./routes');
const service = require('./service');
const { FastDL, FastDLError } = require('./client');

module.exports = { routes, service, FastDL, FastDLError };
