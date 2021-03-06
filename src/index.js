import Crypto from 'crypto';
import axios from 'axios';

class Bitbucket2 {
  constructor(username, password) {
    this.apiVersion = '1.0';
    this.apiUrl = `https://api.bitbucket.org/${this.apiVersion}`;
    this.username = username;
    this.password = password;
  }

  getUser() {
    // currently not in use, maybe in the future it will be.
    const { username, password, apiUrl } = this;
    return axios({
      method: 'get',
      url: `${apiUrl}/user`,
      auth: {
        username,
        password,
      },
    }).then(response => response.data);
  }

  getPrivileges() {
    const { username, password, apiUrl } = this;
    return axios({
      method: 'get',
      url: `${apiUrl}/user/privileges/`,
      auth: {
        username,
        password,
      },
    }).then(response => response.data);
  }
}

/**
 * Default cache time-to-live in seconds
 * It could be changed via config ttl option,
 * which should be also defined in seconds
 *
 * @type {number}
 * @access private
 */
const CACHE_TTL = 24 * 60 * 60;

/**
 * Cache cleanup time-to-live flag in seconds
 * It is used to run cleanup of the users cache once per given period
 * to remove garbage out of the memory
 *
 * @type {number}
 * @access private
 */
const CLEANUP_TTL = 60 * 60;

/**
 * Users cache storage
 *
 * @type {Object}
 * @access private
 */
const userCache = {};

/**
 * Time cleanup
 * @type {Date}
 * @access private
 */
let lastCleanup = new Date();

/**
 * Parses config allow option and returns result
 *
 * @param {string} allow - string to parse
 * @returns {Object}
 * @access private
 */
function parseAllow(allow) {
  const result = {};

  allow.split(/\s*,\s*/).forEach((team) => {
    const newTeam = team.trim().match(/^(.*?)(\((.*?)\))?$/);

    result[newTeam[1]] = newTeam[3] ? newTeam[3].split('|') : [];
  });

  return result;
}

/**
 * Checks if a given cache object should be treated as empty
 *
 * @param {{teams: {Array}, expires: {Date}}} cache
 * @returns {boolean}
 * @access private
 */
function empty(cache) {
  if (!cache ||
        !(cache.teams instanceof Array) ||
        !(cache.expires instanceof Date)
    ) {
    return true;
  }

  return new Date() >= cache.expires;
}

/**
 * Removes all expired users from a cache
 *
 * @access private
 */
function cleanup() {
  if (new Date().getTime() - lastCleanup.getTime() < CLEANUP_TTL) {
    return;
  }

  Object.keys(userCache).forEach((hash) => {
    if (empty(userCache[hash])) {
      userCache[hash] = null;
      delete userCache[hash];
    }
  });

  lastCleanup = new Date();
}

/**
 * Decodes a username to an email address.
 *
 * Since the local portion of email addresses
 * can't end with a dot or contain two consecutive
 * dots, we can replace the `@` with `..`. This
 * function converts from the above encoding to
 * a proper email address.
 *
 * @param {string} username
 * @returns {string}
 * @access private
 */
function decodeUsernameToEmail(username) {
  const pos = username.lastIndexOf('..');
  if (pos === -1) {
    return username;
  }

  return `${username.substr(0, pos)}@${username.substr(pos + 2)}`;
}

/**
 * Returns cached record for a given user
 * This is private method running in context of Auth object
 *
 * @param {string} username
 * @param {string} password
 * @returns {{teams: {Array}, expires: {Date}}}
 * @access private
 */
function getCache(username, password) {
  const shasum = Crypto.createHash('sha1');

  shasum.update(JSON.stringify({
    username,
    password,
  }));

  const token = shasum.digest('hex');

  if (!userCache[token]) {
    userCache[token] = {};
  }

  return userCache[token];
}

/**
 * @class Auth
 * @classdesc Auth class implementing an Auth interface for Verdaccio
 * @param {Object} config
 * @param {Object} stuff
 * @returns {Auth}
 * @constructor
 * @access public
 */
function Auth(config, stuff) {
  if (!(this instanceof Auth)) {
    return new Auth(config, stuff);
  }

  this.allow = parseAllow(config.allow);
  this.ttl = (config.ttl || CACHE_TTL) * 1000;
  this.bitbucket = null;
  this.logger = stuff.logger;
}

/**
 * Logs a given error
 * This is private method running in context of Auth object
 *
 * @param {object} logger
 * @param {string} err
 * @param {string} username
 * @access private
 */
const logError = (logger, err, username) => {
  logger.warn(`${err.code}, user: ${username}, Bitbucket API adaptor error: ${err.message}`);
};

/**
 * Performs user authentication by a given credentials
 * On success or failure executing done(err, teams) callback
 *
 * @param {string} username - user name on bitbucket
 * @param {string} password - user password on bitbucket
 * @param {Function} done - success or error callback
 * @access public
 */
Auth.prototype.authenticate = function authenticate(username, password, done) {
  // make sure we keep memory low
  // run in background
  setTimeout(cleanup);

  const cache = getCache(username, password);

  if (!empty(cache)) {
    return done(null, cache.teams);
  }

  this.bitbucket = new Bitbucket2(decodeUsernameToEmail(username), password);

  return this.bitbucket.getPrivileges().then((privileges) => {
    const teams = Object.keys(privileges.teams)
      .filter((team) => {
        if (this.allow[team] === undefined) {
          return false;
        }

        if (!this.allow[team].length) {
          return true;
        }

        return this.allow[team].includes(privileges.teams[team]);
      }, this);

    cache.teams = teams;
    cache.expires = new Date(new Date().getTime() + this.ttl);

    return done(null, teams);
  }).catch((err) => {
    logError(this.logger, err, username);
    return done(err, false);
  });
};

module.exports = Auth;
