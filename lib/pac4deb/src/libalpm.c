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
#include <dirent.h>
#include <sys/mman.h>
#include <dirent.h>
#include <time.h>
#include "alpm.h"
#include "alpm_list.h"

#define DB_DIR "/var/lib/pacman-debian"
#define PKG_CACHE "/var/cache/pacman-debian/packages"
#define DPKG_STATUS "/var/lib/dpkg/status"

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
	void *db; /* back-reference to owning database */
} pkg_internal;

static pkg_internal *pkg_new(const char *name) {
	pkg_internal *p = calloc(1, sizeof(pkg_internal));
	if (p) p->name = strdup(name);
	return p;
}

void pkg_free(pkg_internal *p) {
	if (!p) return;
	free(p->name); free(p->version); free(p->desc); free(p->url);
	free(p->arch); free(p->base64_sig); free(p->depends);
	free(p->conflicts); free(p->provides);
	free(p);
}

/* ---- Handle ---- */
static alpm_db_t *db_new(const char *name, int is_local);
static alpm_list_t *load_dpkg_status(const char *path);
static alpm_list_t *load_localdb_dir(const char *dirpath);
static int load_local_db(alpm_db_t *db);
static int load_sync_db(alpm_db_t *db);

struct __alpm_handle_t {
	char *dbpath;
	char *logfile;
	alpm_db_t *localdb;
	alpm_list_t *syncdbs;
	alpm_errno_t err;
};

alpm_handle_t *alpm_initialize(const char *root, const char *dbpath, alpm_errno_t *err) {
	(void)root;
	alpm_handle_t *h = calloc(1, sizeof(alpm_handle_t));
	if (!h) { if (err) *err = ALPM_ERR_MEMORY; return NULL; }
	h->dbpath = strdup(dbpath && *dbpath ? dbpath : DB_DIR);
	h->localdb = db_new("local", 1);
	load_local_db(h->localdb);
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

/* Parse a single flat JSON package object and return a pkg_internal */
static pkg_internal *json_to_pkg(json_ctx *j) {
	pkg_internal *p = pkg_new("");
	while (json_peek(j) == '"') {
		char *k = json_string(j);
		if (!k) break;
		json_next(j);
		char *v = json_value(j);
		if (strcmp(k, "name") == 0 || strcmp(k, "package") == 0) { free(p->name); p->name = v; v = NULL; }
		else if (strcmp(k, "version") == 0) { free(p->version); p->version = v; v = NULL; }
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
		if (json_peek(j) == ',') json_next(j);
	}
	if (json_peek(j) == '}') json_next(j);
	return p;
}

/* Load JSONL file (one flat JSON object per line) */
alpm_list_t *load_jsonl_file(const char *filepath) {
	alpm_list_t *pkgs = NULL;
	int fd = open(filepath, O_RDONLY);
	if (fd < 0) return NULL;
	struct stat st;
	if (fstat(fd, &st) < 0) { close(fd); return NULL; }
	if (st.st_size == 0) { close(fd); return NULL; }
	char *buf = mmap(NULL, st.st_size, PROT_READ | PROT_WRITE, MAP_PRIVATE, fd, 0);
	close(fd);
	if (buf == MAP_FAILED) return NULL;

	char *line = buf;
	char *end = buf + st.st_size;
	while (line < end) {
		char *nl = memchr(line, '\n', end - line);
		if (nl) *nl = 0;
		if (*line == '{') {
			json_ctx j;
			json_init(&j, line);
			if (json_next(&j) == '{') {
				pkg_internal *p = json_to_pkg(&j);
				if (p->name && *(p->name)) {
					p->origin = ALPM_PKG_FROM_SYNCDB;
					pkgs = alpm_list_add(pkgs, p);
				} else {
					pkg_free(p);
				}
			}
		}
		line = nl ? nl + 1 : end;
	}
	munmap(buf, st.st_size);
	return pkgs;
}

/* Parse a single JSON line from memory buffer */
alpm_list_t *load_jsonl_mem(const char *json_str) {
	alpm_list_t *pkgs = NULL;
	if (!json_str || *json_str != '{') return NULL;
	json_ctx j;
	json_init(&j, (char *)json_str);
	if (json_next(&j) == '{') {
		pkg_internal *p = json_to_pkg(&j);
		if (p->name && *(p->name)) {
			p->origin = ALPM_PKG_FROM_SYNCDB;
			pkgs = alpm_list_add(pkgs, p);
		} else {
			pkg_free(p);
		}
	}
	return pkgs;
}

static alpm_list_t *load_json_file(const char *filepath) {
	return load_jsonl_file(filepath);
}

/* Load packages from dpkg status file */
static alpm_list_t *load_dpkg_status(const char *path) {
	alpm_list_t *pkgs = NULL;
	FILE *f = fopen(path, "r");
	if (!f) return NULL;
	fseek(f, 0, SEEK_END);
	long len = ftell(f);
	rewind(f);
	char *buf = malloc(len + 1);
	if (!buf) { fclose(f); return NULL; }
	int n = fread(buf, 1, len, f);
	buf[n] = 0;
	fclose(f);

	char *p = buf;
	while (p && *p) {
		while (*p == '\n') p++;
		if (!*p) break;
		char *end = strstr(p, "\n\n");
		if (end) *end = 0;

		char name[256] = {0}, version[256] = {0}, arch[64] = {0}, desc[1024] = {0};
		char depends[4096] = {0};
		int is_installed = 0;

		char *line = p;
		while (line && *line) {
			char *nl = strchr(line, '\n');
			if (nl) *nl = 0;
			if (strncmp(line, "Package: ", 9) == 0) strncpy(name, line + 9, sizeof(name) - 1);
			else if (strncmp(line, "Version: ", 9) == 0) strncpy(version, line + 9, sizeof(version) - 1);
			else if (strncmp(line, "Architecture: ", 14) == 0) strncpy(arch, line + 14, sizeof(arch) - 1);
			else if (strncmp(line, "Status: ", 8) == 0 && strstr(line, "install ok installed")) is_installed = 1;
			else if (strncmp(line, "Depends: ", 9) == 0) strncpy(depends, line + 9, sizeof(depends) - 1);
			else if (strncmp(line, "Description: ", 13) == 0) {
				strncpy(desc, line + 13, sizeof(desc) - 1);
				if (nl) {
					char *n = nl + 1;
					while (n && (*n == ' ' || *n == '\t')) {
						char *nnl = strchr(n, '\n');
						if (nnl) *nnl = 0;
						strncat(desc, " ", sizeof(desc) - strlen(desc) - 1);
						strncat(desc, n, sizeof(desc) - strlen(desc) - 1);
						n = nnl ? nnl + 1 : NULL;
					}
				}
			}
			line = nl ? nl + 1 : NULL;
		}

		if (is_installed && name[0]) {
			pkg_internal *pkg = pkg_new(name);
			pkg->version = strdup(version);
			pkg->arch = strdup(arch[0] ? arch : "arm64");
			pkg->desc = strdup(desc[0] ? desc : "");
			pkg->depends = strdup(depends);
			pkg->reason = ALPM_PKG_REASON_EXPLICIT;
			pkgs = alpm_list_add(pkgs, pkg);
		}
		p = end ? end + 2 : NULL;
	}
	free(buf);
	return pkgs;
}

/* Load all packages from local DB directory (each subdir has a desc file) */
static alpm_list_t *load_localdb_dir(const char *dirpath) {
	alpm_list_t *pkgs = NULL;
	DIR *d = opendir(dirpath);
	if (!d) return NULL;
	struct dirent *entry;
	while ((entry = readdir(d)) != NULL) {
		if (entry->d_name[0] == '.') continue;
		if (strcmp(entry->d_name, "by-name") == 0) continue;
		char path[4096];
		snprintf(path, sizeof(path), "%s/%s/desc", dirpath, entry->d_name);
		int fd = open(path, O_RDONLY);
		if (fd < 0) continue;
		struct stat st;
		if (fstat(fd, &st) < 0 || st.st_size == 0) { close(fd); continue; }
		char *buf = mmap(NULL, st.st_size, PROT_READ, MAP_PRIVATE, fd, 0);
		close(fd);
		if (buf == MAP_FAILED) continue;
		json_ctx j;
		json_init(&j, buf);
		if (json_next(&j) != '{') { munmap(buf, st.st_size); continue; }
		pkg_internal *p = json_to_pkg(&j);
		if (p->name && *(p->name)) {
			p->origin = ALPM_PKG_FROM_LOCALDB;
			pkgs = alpm_list_add(pkgs, p);
		} else {
			pkg_free(p);
		}
		munmap(buf, st.st_size);
	}
	closedir(d);
	return pkgs;
}

/* Load local database: our packages + dpkg status */
static int load_local_db(alpm_db_t *db) {
	if (db->pkgs) return 0;
	char path[4096];
	snprintf(path, sizeof(path), "%s/local", DB_DIR);
	db->pkgs = load_localdb_dir(path);

	// Also load dpkg status for system packages
	char dpkg_path[4096];
	snprintf(dpkg_path, sizeof(dpkg_path), "%s", DPKG_STATUS);
	alpm_list_t *dpkg_pkgs = load_dpkg_status(dpkg_path);
	if (dpkg_pkgs) {
		if (db->pkgs) {
			alpm_list_t *last = alpm_list_last(db->pkgs);
			last->next = dpkg_pkgs;
			dpkg_pkgs->prev = last;
		} else {
			db->pkgs = dpkg_pkgs;
		}
	}
		return 0;
}

/* Load sync database from JSONL chunks */
static alpm_list_t *load_jsonl_dir(const char *dirpath) {
	alpm_list_t *pkgs = NULL;
	DIR *dir = opendir(dirpath);
	if (!dir) return NULL;
	struct dirent *entry;
	while ((entry = readdir(dir)) != NULL) {
		if (!strstr(entry->d_name, ".jsonl")) continue;
		char path[4096];
		snprintf(path, sizeof(path), "%s/%s", dirpath, entry->d_name);
		alpm_list_t *chunk = load_json_file(path);
		// Append chunk to pkgs
		if (chunk) {
			if (pkgs) {
				alpm_list_t *last = alpm_list_last(pkgs);
				last->next = chunk;
				chunk->prev = last;
			} else {
				pkgs = chunk;
			}
		}
	}
	closedir(dir);
	return pkgs;
}

static int load_sync_db(alpm_db_t *db) {
	if (db->pkgs) return 0;
	char path[4096];
	snprintf(path, sizeof(path), "%s/%s", PKG_CACHE, db->treename);
	db->pkgs = load_jsonl_dir(path);
	/* Set back-reference to owning database on each package */
	alpm_list_t *it;
	for (it = db->pkgs; it; it = it->next) {
		pkg_internal *p = it->data;
		if (p) p->db = db;
	}
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
	/* check if already registered */
	alpm_list_t *it;
	for (it = handle->syncdbs; it; it = it->next) {
		alpm_db_t *db = it->data;
		if (db && strcmp(db->treename, treename) == 0) return db;
	}
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

/* Read a single package from JSONL by offset (shared with stubs_manual.c) */
static alpm_pkg_t *pkg_from_idx_line(const char *pkgdir, const char *chunkfile, int offset) {
	char path[4096];
	snprintf(path, sizeof(path), "%s/%s", pkgdir, chunkfile);
	int fd = open(path, O_RDONLY);
	if (fd < 0) return NULL;
	char buf[65536];
	int n = pread(fd, buf, sizeof(buf) - 1, offset);
	close(fd);
	if (n <= 0) return NULL;
	buf[n] = 0;
	char *nl = strchr(buf, '\n');
	if (nl) *nl = 0;
	if (buf[0] != '{') return NULL;
	alpm_list_t *pkgs = load_jsonl_mem(buf);
	if (!pkgs) return NULL;
	alpm_pkg_t *result = (alpm_pkg_t *)pkgs->data;
	free(pkgs);
	return result;
}

/* Look up package in packages.idx using binary search (fast, no full loading) */
static alpm_pkg_t *pkg_by_idx(alpm_db_t *db, const char *name) {
	char idxpath[4096];
	snprintf(idxpath, sizeof(idxpath), "%s/%s/packages.idx", PKG_CACHE, db->treename);
	int fd = open(idxpath, O_RDONLY);
	if (fd < 0) return NULL;
	struct stat st;
	if (fstat(fd, &st) < 0) { close(fd); return NULL; }
	char *buf = malloc(st.st_size + 1);
	if (!buf) { close(fd); return NULL; }
	int n = read(fd, buf, st.st_size);
	close(fd);
	if (n <= 0) { free(buf); return NULL; }
	buf[n] = 0;

	/* Split into lines */
	char **lines = NULL;
	int nlines = 0;
	char *line = buf;
	while (line && *line) {
		char *nl = strchr(line, '\n');
		if (nl) *nl = 0;
		if (*line) {
			lines = realloc(lines, (nlines + 1) * sizeof(char*));
			lines[nlines++] = line;
		}
		line = nl ? nl + 1 : NULL;
	}

	/* Binary search */
	int lo = 0, hi = nlines - 1;
	alpm_pkg_t *result = NULL;
	while (lo <= hi) {
		int mid = (lo + hi) / 2;
		char *ln = lines[mid];
		int name_len = 0;
		while (ln[name_len] && ln[name_len] != ' ') name_len++;
		int cmp = strncmp(name, ln, name_len);
		if (cmp == 0 && name_len == (int)strlen(name)) {
			char *last_tab = NULL, *second_last_tab = NULL;
			int tab_count = 0;
			for (char *q = ln; *q; q++) {
				if (*q == '\t') { second_last_tab = last_tab; last_tab = q; tab_count++; }
			}
			if (tab_count >= 2 && last_tab && second_last_tab) {
				int offset = atoi(last_tab + 1);
				*last_tab = 0;
				char *chunkfile = second_last_tab + 1;
				char pkgdir[4096];
				snprintf(pkgdir, sizeof(pkgdir), "%s/%s", PKG_CACHE, db->treename);
				result = pkg_from_idx_line(pkgdir, chunkfile, offset);
				if (result) ((pkg_internal *)result)->db = db;
			}
			break;
		} else if (cmp < 0 || (cmp == 0 && name_len < (int)strlen(name))) {
			hi = mid - 1;
		} else {
			lo = mid + 1;
		}
	}

	free(lines);
	free(buf);
	return result;
}

alpm_pkg_t *alpm_db_get_pkg(alpm_db_t *db, const char *name) {
	if (!db || !name) return NULL;
	if (db->is_local) {
		load_local_db(db);
		alpm_list_t *it;
		for (it = db->pkgs; it; it = it->next) {
			pkg_internal *p = it->data;
			if (p && p->name && strcmp(p->name, name) == 0)
				return (alpm_pkg_t *)p;
		}
		return NULL;
	}
	/* For sync DBs, use fast idx binary search */
	return pkg_by_idx(db, name);
}

/* Scan packages.idx for pattern matching (fast, no full JSONL load) */
static alpm_list_t *search_via_idx(alpm_db_t *db, const alpm_list_t *needles) {
	char idxpath[4096];
	snprintf(idxpath, sizeof(idxpath), "%s/%s/packages.idx", PKG_CACHE, db->treename);
	int fd = open(idxpath, O_RDONLY);
	if (fd < 0) return NULL;
	struct stat st;
	if (fstat(fd, &st) < 0) { close(fd); return NULL; }
	char *buf = malloc(st.st_size + 1);
	if (!buf) { close(fd); return NULL; }
	int n = read(fd, buf, st.st_size);
	close(fd);
	if (n <= 0) { free(buf); return NULL; }
	buf[n] = 0;

	alpm_list_t *results = NULL;
	const alpm_list_t *needle;
	
	char *line = buf;
	while (line && *line) {
		char *nl = strchr(line, '\n');
		if (nl) *nl = 0;
		if (*line) {
			/* line format: pkgName description\tprovides\tchunkFile\toffset */
			const char *desc_start = line;
			while (*desc_start && *desc_start != ' ') desc_start++;
			if (*desc_start == ' ') desc_start++;
			const char *desc_end = desc_start;
			while (*desc_end && *desc_end != '\t') desc_end++;
			
			/* Get pkgName (first token) */
			int name_len = 0;
			while (line[name_len] && line[name_len] != ' ') name_len++;
			
			for (needle = needles; needle; needle = needle->next) {
				const char *pattern = (const char *)needle->data;
				if (!pattern || !*pattern) continue;
				
				/* Check name match */
				char name_buf[512];
				if (name_len < 512) {
					memcpy(name_buf, line, name_len);
					name_buf[name_len] = 0;
				}
				
				int found = 0;
				if (strcasestr(line, pattern)) found = 1; /* name or desc */
				else if (desc_end > desc_start) {
					/* Check description separately */
					int dlen = desc_end - desc_start;
					if (dlen < 4096) {
						char desc_buf[4096];
						memcpy(desc_buf, desc_start, dlen);
						desc_buf[dlen] = 0;
						if (strcasestr(desc_buf, pattern)) found = 1;
					}
				}
				
				if (found) {
					/* Parse idx line to get chunkfile and offset */
					char *last_tab = NULL, *second_last_tab = NULL;
					for (char *q = line; *q; q++) {
						if (*q == '\t') { second_last_tab = last_tab; last_tab = q; }
					}
					if (last_tab && second_last_tab) {
						int offset = atoi(last_tab + 1);
						*last_tab = 0;
						char *chunkfile = second_last_tab + 1;
						char pkgdir[4096];
						snprintf(pkgdir, sizeof(pkgdir), "%s/%s", PKG_CACHE, db->treename);
						alpm_pkg_t *pkg = pkg_from_idx_line(pkgdir, chunkfile, offset);
						if (pkg) {
							((pkg_internal *)pkg)->db = db;
							results = alpm_list_add(results, pkg);
						}
					}
					break;
				}
			}
		}
		line = nl ? nl + 1 : NULL;
	}
	free(buf);
	return results;
}

int alpm_db_search(alpm_db_t *db, const alpm_list_t *needles, alpm_list_t **ret) {
	if (!db || !needles || !ret) return -1;
	*ret = NULL;
	if (db->is_local) {
		load_local_db(db);
		/* Local DB search: iterate packages */
		alpm_list_t *results = NULL;
		const alpm_list_t *p;
		for (p = db->pkgs; p; p = p->next) {
			pkg_internal *pkg = p->data;
			if (!pkg || !pkg->name) continue;
			const alpm_list_t *n;
			for (n = needles; n; n = n->next) {
				const char *pat = (const char *)n->data;
				if (!pat || !*pat) continue;
				if (strcasestr(pkg->name, pat) || (pkg->desc && strcasestr(pkg->desc, pat))) {
					results = alpm_list_add(results, pkg);
					break;
				}
			}
		}
		*ret = results;
	} else {
		/* Sync DB: use fast idx-based search */
		*ret = search_via_idx(db, needles);
	}
	return 0;
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

int alpm_pkg_has_provide(alpm_pkg_t *pkg, const char *name) {
	if (!pkg || !name) return 0;
	pkg_internal *p = (pkg_internal *)pkg;
	if (!p->provides || !*p->provides) return 0;
	char *copy = strdup(p->provides);
	char *token = strtok(copy, ",");
	while (token) {
		while (*token == ' ') token++;
		char *end = token + strlen(token) - 1;
		while (end > token && (*end == ' ')) end--;
		end[1] = 0;
		if (strcmp(token, name) == 0) { free(copy); return 1; }
		token = strtok(NULL, ",");
	}
	free(copy);
	return 0;
}
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
void *alpm_pkg_get_db(alpm_pkg_t *pkg) { return pkg ? ((pkg_internal *)pkg)->db : NULL; }
void alpm_pkg_set_db(alpm_pkg_t *pkg, void *db) { if (pkg) ((pkg_internal *)pkg)->db = db; }
void alpm_pkg_free(alpm_pkg_t *pkg) { pkg_free((pkg_internal *)pkg); }

/* ---- Options ---- */
int alpm_option_add_cachedir(alpm_handle_t *handle, const char *cachedir) { (void)handle; (void)cachedir; return 0; }
int alpm_option_set_logfile(alpm_handle_t *handle, const char *logfile) {
	if (handle) { free(handle->logfile); handle->logfile = strdup(logfile ? logfile : ""); }
	return 0;
}
int alpm_option_set_cachedirs(alpm_handle_t *handle, alpm_list_t *cachedirs) { (void)handle; (void)cachedirs; return 0; }
int alpm_option_set_dbpath(alpm_handle_t *handle, const char *dbpath) {
	if (handle) { free(handle->dbpath); handle->dbpath = strdup(dbpath ? dbpath : DB_DIR); }
	return 0;
}
int alpm_option_set_gpgdir(alpm_handle_t *handle, const char *gpgdir) { (void)handle; (void)gpgdir; return 0; }
const char *alpm_option_get_dbpath(alpm_handle_t *handle) { return handle ? handle->dbpath : DB_DIR; }
alpm_db_t *alpm_option_get_localdb(alpm_handle_t *handle) { return handle ? handle->localdb : NULL; }
/* Check if a sync db's packages.idx exists */
static int sync_db_has_idx(alpm_db_t *db) {
	char path[4096];
	snprintf(path, sizeof(path), "%s/%s/packages.idx", PKG_CACHE, db->treename);
	struct stat st;
	return stat(path, &st) == 0 ? 1 : 0;
}

static void ensure_syncdbs(alpm_handle_t *handle) {
	if (!handle || handle->syncdbs) return;
	DIR *d = opendir(PKG_CACHE);
	if (!d) return;
	struct dirent *e;
	while ((e = readdir(d)) != NULL) {
		if (e->d_name[0] == '.') continue;
		char p[4096];
		snprintf(p, sizeof(p), "%s/%s", PKG_CACHE, e->d_name);
		struct stat st;
		if (stat(p, &st) == 0 && S_ISDIR(st.st_mode)) {
			alpm_db_t *db = db_new(e->d_name, 0);
			if (db) {
				/* Don't load packages yet - lazy loading via idx */
				handle->syncdbs = alpm_list_add(handle->syncdbs, db);
			}
		}
	}
	closedir(d);
}

alpm_list_t *alpm_option_get_syncdbs(alpm_handle_t *handle) {
	if (handle) ensure_syncdbs(handle);
	return handle ? handle->syncdbs : NULL;
}

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

/* ---- Go/CGO aliases used by AUR helpers ---- */
alpm_db_t *alpm_register_syncdb(alpm_handle_t *handle, const char *treename, int level) {
	(void)level;
	if (!handle || !treename) return NULL;
	alpm_list_t *it;
	for (it = handle->syncdbs; it; it = it->next) {
		alpm_db_t *db = it->data;
		if (db && strcmp(db->treename, treename) == 0) return db;
	}
	alpm_db_t *db = db_new(treename, 0);
	if (!db) return NULL;
	load_sync_db(db);
	handle->syncdbs = alpm_list_add(handle->syncdbs, db);
	return db;
}
alpm_db_t *alpm_get_localdb(alpm_handle_t *handle) { return alpm_option_get_localdb(handle); }
alpm_list_t *alpm_get_syncdbs(alpm_handle_t *handle) { return alpm_option_get_syncdbs(handle); }
int alpm_db_unregister(alpm_db_t *db) { (void)db; return 0; }
const char *alpm_option_get_gpgdir(alpm_handle_t *handle) { (void)handle; return NULL; }
const char *alpm_option_get_logfile(alpm_handle_t *handle) { (void)handle; return NULL; }
int alpm_option_set_local_file_siglevel(alpm_handle_t *handle, int level) { (void)handle; (void)level; return 0; }
int alpm_option_get_local_file_siglevel(alpm_handle_t *handle) { (void)handle; return 0; }
int alpm_option_set_remote_file_siglevel(alpm_handle_t *handle, int level) { (void)handle; (void)level; return 0; }
int alpm_option_get_remote_file_siglevel(alpm_handle_t *handle) { (void)handle; return 0; }
int alpm_option_set_dbext(alpm_handle_t *handle, const char *ext) { (void)handle; (void)ext; return 0; }
const char *alpm_option_get_dbext(alpm_handle_t *handle) { (void)handle; return NULL; }
int alpm_option_set_disable_dl_timeout(alpm_handle_t *handle, int disable) { (void)handle; (void)disable; return 0; }
int alpm_option_get_disable_dl_timeout(alpm_handle_t *handle) { (void)handle; return 0; }
int alpm_option_set_disable_sandbox(alpm_handle_t *handle, int disable) { (void)handle; (void)disable; return 0; }
int alpm_option_get_disable_sandbox(alpm_handle_t *handle) { (void)handle; return 0; }
int alpm_trans_init(alpm_handle_t *handle, int flags) { (void)handle; (void)flags; return 0; }
int alpm_trans_prepare(alpm_handle_t *handle) { (void)handle; return 0; }
int alpm_trans_commit(alpm_handle_t *handle) { (void)handle; return 0; }
int alpm_trans_release(alpm_handle_t *handle) { (void)handle; return 0; }
int alpm_add_pkg(alpm_handle_t *handle, alpm_pkg_t *pkg) { (void)handle; (void)pkg; return 0; }
int alpm_remove_pkg(alpm_handle_t *handle, alpm_pkg_t *pkg) { (void)handle; (void)pkg; return 0; }
int alpm_sync_sysupgrade(alpm_handle_t *handle, int enable_downgrade) { (void)handle; (void)enable_downgrade; return 0; }
