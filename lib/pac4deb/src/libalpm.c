/*
 * libalpm replacement for pacman-debian
 * Reads JSON databases from /var/lib/pacman-debian/
 */
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdarg.h>
#include <sys/stat.h>
#include <unistd.h>
#include <fcntl.h>
#include <sys/mman.h>
#include <dirent.h>
#include <time.h>
#include "alpm.h"
#include "alpm_list.h"

#define DB_DIR "/var/lib/pacman-debian"
#define PKG_CACHE "/var/cache/pacman-debian/packages"

/* ---- Simple JSON scanner ---- */
typedef struct { char *buf; size_t len; size_t pos; } json_ctx;

static void json_init(json_ctx *j, char *buf) {
	j->buf = buf; j->len = strlen(buf); j->pos = 0;
}

static void json_skipws(json_ctx *j) {
	while (j->pos < j->len) {
		char c = j->buf[j->pos];
		if (c == ' ' || c == '\t' || c == '\n' || c == '\r') j->pos++;
		else break;
	}
}

static int json_peek(json_ctx *j) { json_skipws(j); return j->pos < j->len ? j->buf[j->pos] : 0; }

static int json_next(json_ctx *j) {
	json_skipws(j);
	return j->pos < j->len ? j->buf[j->pos++] : 0;
}

static char *json_string(json_ctx *j) {
	if (json_next(j) != '"') return NULL;
	size_t start = j->pos;
	while (j->pos < j->len && j->buf[j->pos] != '"') {
		if (j->buf[j->pos] == '\\') j->pos++;
		j->pos++;
	}
	if (j->pos >= j->len) return NULL;
	size_t len = j->pos - start;
	char *s = malloc(len + 1);
	memcpy(s, j->buf + start, len);
	s[len] = 0;
	j->pos++; // skip closing quote
	return s;
}

static char *json_value(json_ctx *j) {
	json_skipws(j);
	if (j->pos >= j->len) return NULL;
	char c = j->buf[j->pos];
	if (c == '"') return json_string(j);
	// number/bool/null (read until , ] } or whitespace)
	size_t start = j->pos;
	while (j->pos < j->len) {
		c = j->buf[j->pos];
		if (c == ',' || c == ']' || c == '}' || c == ' ' || c == '\t' || c == '\n' || c == '\r') break;
		j->pos++;
	}
	size_t len = j->pos - start;
	char *s = malloc(len + 1);
	memcpy(s, j->buf + start, len);
	s[len] = 0;
	return s;
}

/* ---- Internal package struct ---- */
typedef struct __alpm_pkg_internal {
	char *name, *version, *desc, *url, *arch, *base64_sig, *depends, *conflicts, *provides;
	alpm_pkgreason_t reason;
	alpm_pkgfrom_t origin;
	alpm_time_t builddate, installdate;
	off_t size, isize;
	alpm_pkgvalidation_t validation;
	int has_scriptlet;
} pkg_internal;

static pkg_internal *pkg_new(const char *name) {
	pkg_internal *p = calloc(1, sizeof(pkg_internal));
	if (p) p->name = strdup(name);
	return p;
}

static void pkg_free(pkg_internal *p) {
	if (!p) return;
	free(p->name); free(p->version); free(p->desc); free(p->url);
	free(p->arch); free(p->base64_sig); free(p->depends);
	free(p->conflicts); free(p->provides);
	free(p);
}

/* ---- Handle ---- */
struct __alpm_handle_t {
	char *dbpath;
	char *logfile;
	alpm_db_t *localdb;
	alpm_list_t *syncdbs;
	alpm_errno_t err;
};

alpm_handle_t *alpm_initialize(const char *root, const char *dbpath, alpm_errno_t *err) {
	(void)root; // ignored; we use fixed paths
	alpm_handle_t *h = calloc(1, sizeof(alpm_handle_t));
	if (!h) { if (err) *err = ALPM_ERR_MEMORY; return NULL; }
	h->dbpath = strdup(dbpath && *dbpath ? dbpath : DB_DIR);
	h->localdb = NULL;
	h->syncdbs = NULL;
	h->err = ALPM_ERR_OK;
	if (err) *err = ALPM_ERR_OK;
	return h;
}

int alpm_release(alpm_handle_t *handle) {
	if (!handle) return -1;
	alpm_db_unregister_all(handle);
	free(handle->dbpath);
	free(handle->logfile);
	free(handle);
	return 0;
}

/* ---- Errors ---- */
alpm_errno_t alpm_errno(alpm_handle_t *handle) { return handle ? handle->err : ALPM_ERR_HANDLE_NULL; }
const char *alpm_strerror(alpm_errno_t err) {
	switch (err) {
		case ALPM_ERR_OK: return "no error";
		case ALPM_ERR_MEMORY: return "out of memory";
		case ALPM_ERR_PKG_NOT_FOUND: return "package not found";
		case ALPM_ERR_DB_NOT_FOUND: return "database not found";
		default: return "unknown error";
	}
}

/* ---- Database ---- */
struct __alpm_db_t {
	char *treename;
	alpm_list_t *pkgs;
	int is_local;
};

static alpm_db_t *db_new(const char *name, int is_local) {
	alpm_db_t *db = calloc(1, sizeof(alpm_db_t));
	if (db) { db->treename = strdup(name ? name : "local"); db->is_local = is_local; }
	return db;
}

/* Load JSON file and parse package entries */
static alpm_list_t *load_json_file(const char *filepath) {
	alpm_list_t *pkgs = NULL;
	int fd = open(filepath, O_RDONLY);
	if (fd < 0) return NULL;
	struct stat st;
	if (fstat(fd, &st) < 0) { close(fd); return NULL; }
	if (st.st_size == 0) { close(fd); return NULL; }
	char *buf = mmap(NULL, st.st_size, PROT_READ, MAP_PRIVATE, fd, 0);
	close(fd);
	if (buf == MAP_FAILED) return NULL;

	json_ctx j;
	json_init(&j, buf);
	if (json_next(&j) != '{') { munmap(buf, st.st_size); return NULL; }

	while (json_peek(&j) == '"') {
		char *key = json_string(&j);
		if (!key) break;
		if (json_next(&j) != ':') { free(key); break; }

		if (json_peek(&j) == '{') {
			// Parse package object
			json_next(&j); // skip {
			pkg_internal *p = pkg_new(key);
			free(key);
			while (json_peek(&j) == '"') {
				char *k = json_string(&j);
				if (!k) break;
				json_next(&j); // skip :
				char *v = json_value(&j);
				if (strcmp(k, "version") == 0) { free(p->version); p->version = v; v = NULL; }
				else if (strcmp(k, "description") == 0) { free(p->desc); p->desc = v; v = NULL; }
				else if (strcmp(k, "url") == 0 || strcmp(k, "homepage") == 0) { free(p->url); p->url = v; v = NULL; }
				else if (strcmp(k, "architecture") == 0 || strcmp(k, "arch") == 0) { free(p->arch); p->arch = v; v = NULL; }
				else if (strcmp(k, "installTime") == 0) p->installdate = atol(v ? v : "0");
				else if (strcmp(k, "reason") == 0) p->reason = (v && strcmp(v, "explicit") == 0) ? ALPM_PKG_REASON_EXPLICIT : ALPM_PKG_REASON_DEPEND;
				else if (strcmp(k, "installedSize") == 0) p->isize = atol(v ? v : "0");
				else if (strcmp(k, "size") == 0) p->size = atol(v ? v : "0");
				else if (strcmp(k, "depends") == 0) { free(p->depends); p->depends = v; v = NULL; }
				else if (strcmp(k, "conflicts") == 0) { free(p->conflicts); p->conflicts = v; v = NULL; }
				else if (strcmp(k, "provides") == 0) { free(p->provides); p->provides = v; v = NULL; }
				free(k); free(v);
				if (json_peek(&j) == ',') json_next(&j);
			}
			if (json_peek(&j) == '}') json_next(&j);
			pkgs = alpm_list_add(pkgs, p);
		} else {
			// Skip non-object value
			free(key);
			free(json_value(&j));
		}
		if (json_peek(&j) == ',') json_next(&j);
	}
	munmap(buf, st.st_size);
	return pkgs;
}

/* Load local database from status.json */
static int load_local_db(alpm_db_t *db) {
	if (db->pkgs) return 0;
	char path[4096];
	snprintf(path, sizeof(path), "%s/status.json", DB_DIR);
	db->pkgs = load_json_file(path);
	return 0;
}

/* Load sync database from packages cache */
static int load_sync_db(alpm_db_t *db) {
	if (db->pkgs) return 0;
	char path[4096];
	snprintf(path, sizeof(path), "%s/%s.json", PKG_CACHE, db->treename);
	db->pkgs = load_json_file(path);
	return 0;
}

alpm_db_t *alpm_db_register_local(alpm_handle_t *handle) {
	if (!handle) return NULL;
	handle->localdb = db_new("local", 1);
	load_local_db(handle->localdb);
	return handle->localdb;
}

alpm_db_t *alpm_db_register_sync(alpm_handle_t *handle, const char *treename) {
	if (!handle || !treename) return NULL;
	alpm_db_t *db = db_new(treename, 0);
	if (!db) return NULL;
	load_sync_db(db);
	handle->syncdbs = alpm_list_add(handle->syncdbs, db);
	return db;
}

int alpm_db_unregister_all(alpm_handle_t *handle) {
	if (!handle) return -1;
	if (handle->localdb) {
		alpm_list_free_inner((alpm_list_t *)handle->localdb->pkgs, (void(*)(void*))pkg_free);
		free(handle->localdb);
		handle->localdb = NULL;
	}
	alpm_list_t *it;
	for (it = handle->syncdbs; it; it = it->next) {
		alpm_db_t *db = it->data;
		if (db) {
			alpm_list_free_inner((alpm_list_t *)db->pkgs, (void(*)(void*))pkg_free);
			free(db);
		}
	}
	alpm_list_free(handle->syncdbs);
	handle->syncdbs = NULL;
	return 0;
}

alpm_pkg_t *alpm_db_get_pkg(alpm_db_t *db, const char *name) {
	if (!db || !name) return NULL;
	if (db->is_local) load_local_db(db);
	else load_sync_db(db);
	alpm_list_t *it;
	for (it = db->pkgs; it; it = it->next) {
		pkg_internal *p = it->data;
		if (p && p->name && strcmp(p->name, name) == 0) return (alpm_pkg_t *)p;
	}
	return NULL;
}

alpm_list_t *alpm_db_get_pkgcache(alpm_db_t *db) {
	if (!db) return NULL;
	if (db->is_local) load_local_db(db);
	else load_sync_db(db);
	return db->pkgs;
}

int alpm_db_set_pkgreason(alpm_handle_t *handle, const char *name, alpm_pkgreason_t reason) {
	(void)handle; (void)name; (void)reason;
	return 0; // no-op for now
}

/* ---- Package property accessors ---- */
const char *alpm_pkg_get_name(alpm_pkg_t *pkg) { return pkg ? ((pkg_internal *)pkg)->name : NULL; }
const char *alpm_pkg_get_version(alpm_pkg_t *pkg) { return pkg ? ((pkg_internal *)pkg)->version : NULL; }
const char *alpm_pkg_get_desc(alpm_pkg_t *pkg) { return pkg ? ((pkg_internal *)pkg)->desc : NULL; }
const char *alpm_pkg_get_url(alpm_pkg_t *pkg) { return pkg ? ((pkg_internal *)pkg)->url : NULL; }
const char *alpm_pkg_get_arch(alpm_pkg_t *pkg) { return pkg ? ((pkg_internal *)pkg)->arch : NULL; }
const char *alpm_pkg_get_base64_sig(alpm_pkg_t *pkg) { return pkg ? ((pkg_internal *)pkg)->base64_sig : NULL; }
alpm_pkgreason_t alpm_pkg_get_reason(alpm_pkg_t *pkg) { return pkg ? ((pkg_internal *)pkg)->reason : ALPM_PKG_REASON_DEPEND; }
alpm_pkgfrom_t alpm_pkg_get_origin(alpm_pkg_t *pkg) { return pkg ? ((pkg_internal *)pkg)->origin : ALPM_PKG_FROM_LOCALDB; }
alpm_time_t alpm_pkg_get_builddate(alpm_pkg_t *pkg) { (void)pkg; return 0; }
alpm_time_t alpm_pkg_get_installdate(alpm_pkg_t *pkg) { return pkg ? ((pkg_internal *)pkg)->installdate : 0; }
off_t alpm_pkg_get_size(alpm_pkg_t *pkg) { return pkg ? ((pkg_internal *)pkg)->size : 0; }
off_t alpm_pkg_get_isize(alpm_pkg_t *pkg) { return pkg ? ((pkg_internal *)pkg)->isize : 0; }
alpm_pkgvalidation_t alpm_pkg_get_validation(alpm_pkg_t *pkg) { (void)pkg; return ALPM_PKG_VALIDATION_NONE; }
int alpm_pkg_has_scriptlet(alpm_pkg_t *pkg) { return pkg ? ((pkg_internal *)pkg)->has_scriptlet : 0; }
void alpm_pkg_free(alpm_pkg_t *pkg) { pkg_free((pkg_internal *)pkg); }

/* ---- Options ---- */
int alpm_option_add_cachedir(alpm_handle_t *handle, const char *cachedir) { (void)handle; (void)cachedir; return 0; }
void alpm_option_set_dbpath(alpm_handle_t *handle, const char *dbpath) {
	if (handle) { free(handle->dbpath); handle->dbpath = strdup(dbpath ? dbpath : DB_DIR); }
}
void alpm_option_set_logfile(alpm_handle_t *handle, const char *logfile) {
	if (handle) { free(handle->logfile); handle->logfile = strdup(logfile ? logfile : ""); }
}
const char *alpm_option_get_dbpath(alpm_handle_t *handle) { return handle ? handle->dbpath : DB_DIR; }
alpm_db_t *alpm_option_get_localdb(alpm_handle_t *handle) { return handle ? handle->localdb : NULL; }
alpm_list_t *alpm_option_get_syncdbs(alpm_handle_t *handle) { return handle ? handle->syncdbs : NULL; }

/* ---- Logging ---- */
int alpm_logaction(alpm_handle_t *handle, const char *fmt, ...) {
	(void)handle;
	va_list ap;
	va_start(ap, fmt);
	vfprintf(stderr, fmt, ap);
	va_end(ap);
	return 0;
}

/* ---- Version comparison ---- */
int alpm_pkg_vercmp(const char *a, const char *b) {
	if (!a && !b) return 0;
	if (!a) return -1;
	if (!b) return 1;
	return strcmp(a, b); // simplified
}

/* ---- Misc ---- */
const char *alpm_version(void) { return "7.1.0"; }
int alpm_capabilities(void) { return ALPM_CAPABILITY_NLS; }
