/* Hand-written stubs for libalpm functions not in libalpm.c */
#include "../include/alpm.h"
#include "../include/alpm_list.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <dirent.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>

/* Option setters/getters not implemented */
int alpm_option_set_usesyslog(alpm_handle_t *h, int v) { (void)h; (void)v; return 0; }
int alpm_option_set_checkspace(alpm_handle_t *h, int v) { (void)h; (void)v; return 0; }
int alpm_option_set_default_siglevel(alpm_handle_t *h, int v) { (void)h; (void)v; return 0; }
int alpm_option_set_parallel_downloads(alpm_handle_t *h, int v) { (void)h; (void)v; return 0; }
int alpm_option_set_hookdirs(alpm_handle_t *h, void *v) { (void)h; (void)v; return 0; }
int alpm_option_set_noupgrades(alpm_handle_t *h, void *v) { (void)h; (void)v; return 0; }
int alpm_option_set_noextracts(alpm_handle_t *h, void *v) { (void)h; (void)v; return 0; }
int alpm_option_set_ignorepkgs(alpm_handle_t *h, void *v) { (void)h; (void)v; return 0; }
int alpm_option_set_ignoregroups(alpm_handle_t *h, void *v) { (void)h; (void)v; return 0; }
int alpm_option_set_overwrite_files(alpm_handle_t *h, void *v) { (void)h; (void)v; return 0; }
int alpm_option_set_sandboxuser(alpm_handle_t *h, const char *v) { (void)h; (void)v; return 0; }
int alpm_option_set_architectures(alpm_handle_t *h, void *v) { (void)h; (void)v; return 0; }
int alpm_option_set_assumeinstalled(alpm_handle_t *h, void *v) { (void)h; (void)v; return 0; }
int alpm_option_set_dlopen(alpm_handle_t *h, int v) { (void)h; (void)v; return 0; }
int alpm_option_set_lockfile(alpm_handle_t *h, const char *v) { (void)h; (void)v; return 0; }
int alpm_option_set_disable_sandbox_filesystem(alpm_handle_t *h, int v) { (void)h; (void)v; return 0; }
int alpm_option_set_disable_sandbox_syscalls(alpm_handle_t *h, int v) { (void)h; (void)v; return 0; }
int alpm_option_set_dlcb(alpm_handle_t *h, void *cb) { (void)h; (void)cb; }
int alpm_option_set_eventcb(alpm_handle_t *h, void *cb) { (void)h; (void)cb; }
int alpm_option_set_fetchcb(alpm_handle_t *h, void *cb) { (void)h; (void)cb; }
int alpm_option_set_logcb(alpm_handle_t *h, void *cb) { (void)h; (void)cb; }
int alpm_option_set_questioncb(alpm_handle_t *h, void *cb) { (void)h; (void)cb; }
int alpm_option_set_progresscb(alpm_handle_t *h, void *cb) { (void)h; (void)cb; }

/* Option getters */
int alpm_option_get_usesyslog(alpm_handle_t *h) { (void)h; return 0; }
int alpm_option_get_checkspace(alpm_handle_t *h) { (void)h; return 0; }
int alpm_option_get_default_siglevel(alpm_handle_t *h) { (void)h; return 0; }
int alpm_option_get_parallel_downloads(alpm_handle_t *h) { (void)h; return 0; }
int alpm_option_get_dlopen(alpm_handle_t *h) { (void)h; return 0; }
int alpm_option_get_dlopen_ctx(alpm_handle_t *h) { (void)h; return 0; }
int alpm_option_get_disable_sandbox_filesystem(alpm_handle_t *h) { (void)h; return 0; }
int alpm_option_get_disable_sandbox_syscalls(alpm_handle_t *h) { (void)h; return 0; }
void *alpm_option_get_dlcb(alpm_handle_t *h) { (void)h; return NULL; }
void *alpm_option_get_eventcb(alpm_handle_t *h) { (void)h; return NULL; }
void *alpm_option_get_fetchcb(alpm_handle_t *h) { (void)h; return NULL; }
void *alpm_option_get_logcb(alpm_handle_t *h) { (void)h; return NULL; }
void *alpm_option_get_questioncb(alpm_handle_t *h) { (void)h; return NULL; }
void *alpm_option_get_progresscb(alpm_handle_t *h) { (void)h; return NULL; }
void *alpm_option_get_dlcb_ctx(alpm_handle_t *h) { (void)h; return NULL; }
void *alpm_option_get_eventcb_ctx(alpm_handle_t *h) { (void)h; return NULL; }
void *alpm_option_get_fetchcb_ctx(alpm_handle_t *h) { (void)h; return NULL; }
void *alpm_option_get_logcb_ctx(alpm_handle_t *h) { (void)h; return NULL; }
void *alpm_option_get_questioncb_ctx(alpm_handle_t *h) { (void)h; return NULL; }
void *alpm_option_get_progresscb_ctx(alpm_handle_t *h) { (void)h; return NULL; }
const char *alpm_option_get_root(alpm_handle_t *h) { (void)h; return NULL; }
void *alpm_option_get_cachedirs(alpm_handle_t *h) { (void)h; return NULL; }
void *alpm_option_get_hookdirs(alpm_handle_t *h) { (void)h; return NULL; }
void *alpm_option_get_noupgrades(alpm_handle_t *h) { (void)h; return NULL; }
void *alpm_option_get_noextracts(alpm_handle_t *h) { (void)h; return NULL; }
void *alpm_option_get_ignorepkgs(alpm_handle_t *h) { (void)h; return NULL; }
void *alpm_option_get_ignoregroups(alpm_handle_t *h) { (void)h; return NULL; }
void *alpm_option_get_overwrite_files(alpm_handle_t *h) { (void)h; return NULL; }
void *alpm_option_get_sandboxuser(alpm_handle_t *h) { (void)h; return NULL; }
void *alpm_option_get_architectures(alpm_handle_t *h) { (void)h; return NULL; }
void *alpm_option_get_assumeinstalled(alpm_handle_t *h) { (void)h; return NULL; }

/* Option add/remove helpers */
int alpm_option_add_hookdir(alpm_handle_t *h, const char *d) { (void)h; (void)d; return 0; }
int alpm_option_add_architecture(alpm_handle_t *h, const char *a) { (void)h; (void)a; return 0; }
int alpm_option_add_assumeinstalled(alpm_handle_t *h, void *d) { (void)h; (void)d; return 0; }
int alpm_option_add_ignorepkg(alpm_handle_t *h, const char *p) { (void)h; (void)p; return 0; }
int alpm_option_add_ignoregroup(alpm_handle_t *h, const char *g) { (void)h; (void)g; return 0; }
int alpm_option_add_noupgrade(alpm_handle_t *h, const char *f) { (void)h; (void)f; return 0; }
int alpm_option_add_noextract(alpm_handle_t *h, const char *f) { (void)h; (void)f; return 0; }
int alpm_option_add_overwrite_file(alpm_handle_t *h, const char *f) { (void)h; (void)f; return 0; }
int alpm_option_remove_cachedir(alpm_handle_t *h, const char *d) { (void)h; (void)d; return 0; }
int alpm_option_remove_hookdir(alpm_handle_t *h, const char *d) { (void)h; (void)d; return 0; }
int alpm_option_remove_architecture(alpm_handle_t *h, const char *a) { (void)h; (void)a; return 0; }
int alpm_option_remove_assumeinstalled(alpm_handle_t *h, void *d) { (void)h; (void)d; return 0; }
int alpm_option_remove_ignorepkg(alpm_handle_t *h, const char *p) { (void)h; (void)p; return 0; }
int alpm_option_remove_ignoregroup(alpm_handle_t *h, const char *g) { (void)h; (void)g; return 0; }
int alpm_option_remove_noupgrade(alpm_handle_t *h, const char *f) { (void)h; (void)f; return 0; }
int alpm_option_remove_noextract(alpm_handle_t *h, const char *f) { (void)h; (void)f; return 0; }
int alpm_option_remove_overwrite_file(alpm_handle_t *h, const char *f) { (void)h; (void)f; return 0; }

/* Match helpers */
int alpm_option_match_noupgrade(alpm_handle_t *h, const char *f) { (void)h; (void)f; return 0; }
int alpm_option_match_noextract(alpm_handle_t *h, const char *f) { (void)h; (void)f; return 0; }

/* Database operations */
int alpm_db_update(alpm_handle_t *h, void *dbs, int force) { (void)h; (void)dbs; (void)force; return 0; }
int alpm_db_get_valid(alpm_db_t *db) { (void)db; return 1; }
const char *alpm_db_get_name(alpm_db_t *db) {
	// treename is the first field of the internal struct
	if (!db) return NULL;
	struct __alpm_db_t { char *treename; void *pkgs; int is_local; };
	return ((struct __alpm_db_t *)db)->treename;
}
void *alpm_db_get_groupcache(alpm_db_t *db) { (void)db; return NULL; }
void *alpm_db_get_group(alpm_db_t *db, const char *n) { (void)db; (void)n; return NULL; }
void *alpm_db_get_servers(alpm_db_t *db) { (void)db; return NULL; }
void *alpm_db_get_cache_servers(alpm_db_t *db) { (void)db; return NULL; }
int alpm_db_set_servers(alpm_db_t *db, void *s) { (void)db; (void)s; return 0; }
int alpm_db_set_cache_servers(alpm_db_t *db, void *s) { (void)db; (void)s; return 0; }
int alpm_db_set_usage(alpm_db_t *db, int u) { (void)db; (void)u; return 0; }
int alpm_db_get_usage(alpm_db_t *db) { (void)db; return 0; }
int alpm_db_get_siglevel(alpm_db_t *db) { (void)db; return 0; }
int alpm_db_check_pgp_signature(alpm_db_t *db) { (void)db; return 0; }
void *alpm_db_get_handle(alpm_db_t *db) { (void)db; return NULL; }
void *alpm_db_add_server(alpm_db_t *db, const char *s) { (void)db; (void)s; return NULL; }
void *alpm_db_add_cache_server(alpm_db_t *db, const char *s) { (void)db; (void)s; return NULL; }
void *alpm_db_remove_server(alpm_db_t *db, const char *s) { (void)db; (void)s; return NULL; }
void *alpm_db_remove_cache_server(alpm_db_t *db, const char *s) { (void)db; (void)s; return NULL; }

/* Package operations */
int alpm_pkg_load(alpm_handle_t *h, const char *fn, int f, int l, void **p) { (void)h; (void)fn; (void)f; (void)l; (void)p; return -1; }
int alpm_pkg_checkmd5sum(alpm_pkg_t *p) { (void)p; return 0; }
int alpm_fetch_pkgurl(alpm_handle_t *h, void *urls) { (void)h; (void)urls; return -1; }
void *alpm_find_group_pkgs(void *dbs, const char *n) { (void)dbs; (void)n; return NULL; }
void *alpm_checkdeps(alpm_handle_t *h, void *pkglist) { (void)h; (void)pkglist; return NULL; }
alpm_pkg_t *alpm_find_satisfier(alpm_list_t *pkgs, const char *dep) {
	if (!pkgs || !dep) return NULL;
	char depname[256];
	int i = 0;
	while (dep[i] && dep[i] != '<' && dep[i] != '>' && dep[i] != '=' && i < 255) {
		depname[i] = dep[i]; i++;
	}
	depname[i] = 0;
	alpm_list_t *it;
	for (it = pkgs; it; it = it->next) {
		alpm_pkg_t *p = (alpm_pkg_t *)it->data;
		if (!p) continue;
		if (strcmp(alpm_pkg_get_name(p), depname) == 0) return p;
		extern int alpm_pkg_has_provide(alpm_pkg_t*, const char*);
		if (alpm_pkg_has_provide(p, depname)) return p;
	}
	return NULL;
}
#define PKG_CACHE "/var/cache/pacman-debian/packages"

/* Forward declarations from libalpm.c */
extern alpm_list_t *load_jsonl_mem(const char *json_str);

/* Read a single package from JSONL by file offset */
static alpm_pkg_t *read_pkg_at(const char *pkgdir, const char *chunkfile, int offset) {
	char path[4096];
	snprintf(path, sizeof(path), "%s/%s", pkgdir, chunkfile);
	int fd = open(path, O_RDONLY);
	if (fd < 0) return NULL;
	/* Read up to 64KB from offset */
	char buf[65536];
	int n = pread(fd, buf, sizeof(buf) - 1, offset);
	close(fd);
	if (n <= 0) return NULL;
	buf[n] = 0;
	/* Find newline to get a complete JSON line */
	char *nl = strchr(buf, '\n');
	if (nl) *nl = 0;
	if (buf[0] != '{') return NULL;
	alpm_list_t *pkgs = load_jsonl_mem(buf);
	if (!pkgs) return NULL;
	alpm_pkg_t *result = (alpm_pkg_t *)pkgs->data;
	free(pkgs);
	return result;
}

/* Find a package by exact name in a packages.idx file using binary search */
static alpm_pkg_t *find_in_idx(const char *idxpath, const char *pkgname) {
	/* Read the idx file */
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
		/* Get package name (first token before space) */
		char *ln = lines[mid];
		int name_len = 0;
		while (ln[name_len] && ln[name_len] != ' ') name_len++;
		int cmp = strncmp(pkgname, ln, name_len);
		if (cmp == 0 && name_len == (int)strlen(pkgname)) {
			/* Found! Parse idx line format: name desc\t[provides]\tchunkfile\toffset */
			/* Find last two tabs to get chunkfile and offset */
			char *p = ln + strlen(ln);
			/* Find offset (after last tab) */
			char *last_tab = NULL, *second_last_tab = NULL;
			int tab_count = 0;
			for (char *q = ln; *q; q++) {
				if (*q == '\t') {
					second_last_tab = last_tab;
					last_tab = q;
					tab_count++;
				}
			}
			if (tab_count >= 2 && last_tab && second_last_tab) {
				int offset = atoi(last_tab + 1);
				*last_tab = 0;
				char *chunkfile = second_last_tab + 1;
				/* Get pkgdir from idxpath: strip "/packages.idx" */
				int plen = strlen(idxpath) - 12; /* len of "/packages.idx" */
				char pkgdir[4096];
				strncpy(pkgdir, idxpath, plen);
				pkgdir[plen] = 0;
				result = read_pkg_at(pkgdir, chunkfile, offset);
			}
			break;
		} else if (cmp < 0 || (cmp == 0 && name_len < (int)strlen(pkgname))) {
			hi = mid - 1;
		} else {
			lo = mid + 1;
		}
	}

	free(lines);
	free(buf);
	return result;
}

/* Dep name: strip version constraints */
static void dep_name(const char *dep, char *out, int outlen) {
	int i = 0;
	while (dep[i] && dep[i] != '<' && dep[i] != '>' && dep[i] != '=' && i < outlen - 1) {
		out[i] = dep[i]; i++;
	}
	out[i] = 0;
}

alpm_pkg_t *alpm_find_dbs_satisfier(alpm_handle_t *h, alpm_list_t *dbs, const char *dep) {
	(void)h;
	if (!dep) return NULL;
	char depname[256];
	dep_name(dep, depname, sizeof(depname));

	/* Search registered databases using fast idx binary search */
	if (dbs) {
		alpm_list_t *it;
		for (it = dbs; it; it = it->next) {
			alpm_db_t *db = (alpm_db_t *)it->data;
			if (!db) continue;
			/* Get treename from db */
			extern const char *alpm_db_get_name(alpm_db_t *db);
			const char *name = alpm_db_get_name(db);
			if (!name) continue;
			char idxpath[4096];
			snprintf(idxpath, sizeof(idxpath), "%s/%s/packages.idx", PKG_CACHE, name);
			struct stat st;
			if (stat(idxpath, &st) != 0) continue;
			alpm_pkg_t *found = find_in_idx(idxpath, depname);
			if (found) {
				extern void alpm_pkg_set_db(alpm_pkg_t *, void *);
				alpm_pkg_set_db(found, db);
				return found;
			}
		}
		return NULL;
	}

	/* Fallback: search all packages.idx files directly */
	DIR *dir = opendir(PKG_CACHE);
	if (!dir) return NULL;
	struct dirent *e;
	while ((e = readdir(dir)) != NULL) {
		if (e->d_name[0] == '.') continue;
		char idxpath[4096];
		snprintf(idxpath, sizeof(idxpath), "%s/%s/packages.idx", PKG_CACHE, e->d_name);
		struct stat st;
		if (stat(idxpath, &st) != 0) continue;
		alpm_pkg_t *found = find_in_idx(idxpath, depname);
		if (found) {
			closedir(dir);
			return found;
		}
	}
	closedir(dir);
	return NULL;
}
int alpm_checkconflicts(alpm_handle_t *h, void *pkglist) { (void)h; (void)pkglist; return 0; }
void *alpm_dep_from_string(const char *s) { (void)s; return NULL; }
const char *alpm_dep_compute_string(void *d) { (void)d; return NULL; }
void alpm_dep_free(void *d) { (void)d; }
void alpm_conflict_free(void *c) { (void)c; }
void alpm_fileconflict_free(void *c) { (void)c; }
void alpm_depmissing_free(void *m) { (void)m; }
void alpm_siglist_cleanup(void *s) { (void)s; }
int alpm_decode_signature(const char *b, unsigned char **d, size_t *l) { (void)b; (void)d; (void)l; return -1; }
int alpm_extract_keyid(alpm_handle_t *h, const char *id, const unsigned char *sig, size_t len, void **keys) { (void)h; (void)id; (void)sig; (void)len; (void)keys; return -1; }
int alpm_unlock(alpm_handle_t *h) { (void)h; return 0; }

/* Package property getters (some are already in libalpm.c - these cover the rest) */
const char *alpm_pkg_get_filename(alpm_pkg_t *p) { (void)p; return NULL; }
const char *alpm_pkg_get_md5sum(alpm_pkg_t *p) { (void)p; return NULL; }
const char *alpm_pkg_get_base(alpm_pkg_t *p) { (void)p; return NULL; }
const char *alpm_pkg_get_packager(alpm_pkg_t *p) { (void)p; return NULL; }
const char *alpm_pkg_get_sha256sum(alpm_pkg_t *p) { (void)p; return NULL; }
void *alpm_pkg_get_backup(alpm_pkg_t *p) { (void)p; return NULL; }
void *alpm_pkg_get_files(alpm_pkg_t *p) { (void)p; return NULL; }
void *alpm_pkg_get_groups(alpm_pkg_t *p) { (void)p; return NULL; }
void *alpm_pkg_get_licenses(alpm_pkg_t *p) { (void)p; return NULL; }
void *alpm_pkg_get_depends(alpm_pkg_t *p) { (void)p; return NULL; }
void *alpm_pkg_get_optdepends(alpm_pkg_t *p) { (void)p; return NULL; }
void *alpm_pkg_get_conflicts(alpm_pkg_t *p) { (void)p; return NULL; }
void *alpm_pkg_get_provides(alpm_pkg_t *p) { (void)p; return NULL; }
void *alpm_pkg_get_replaces(alpm_pkg_t *p) { (void)p; return NULL; }
void *alpm_pkg_get_checkdepends(alpm_pkg_t *p) { (void)p; return NULL; }
void *alpm_pkg_get_makedepends(alpm_pkg_t *p) { (void)p; return NULL; }
void *alpm_pkg_get_xdata(alpm_pkg_t *p) { (void)p; return NULL; }
void *alpm_pkg_get_handle(alpm_pkg_t *p) { (void)p; return NULL; }
alpm_pkg_t *alpm_pkg_find(void *list, const char *name) { (void)list; (void)name; return NULL; }
int alpm_pkg_should_ignore(alpm_handle_t *h, alpm_pkg_t *p) { (void)h; (void)p; return 0; }
int alpm_pkg_download_size(alpm_pkg_t *p) { (void)p; return 0; }
int alpm_filelist_contains(void *fl, const char *path) { (void)fl; (void)path; return 0; }
int alpm_pkg_changelog_open(alpm_pkg_t *p) { (void)p; return -1; }
int alpm_pkg_mtree_open(alpm_pkg_t *p) { (void)p; return -1; }
int alpm_pkg_mtree_next(alpm_pkg_t *p, void *entry) { (void)p; (void)entry; return 1; }
int alpm_pkg_mtree_close(alpm_pkg_t *p) { (void)p; return 0; }
int alpm_pkg_changelog_close(alpm_pkg_t *p) { (void)p; return 0; }
int alpm_pkg_changelog_read(void *ptr, size_t size, const alpm_pkg_t *p) { (void)ptr; (void)size; (void)p; return 0; }
int alpm_pkg_check_pgp_signature(alpm_pkg_t *p, void *sig) { (void)p; (void)sig; return -1; }
int alpm_pkg_compute_requiredby(alpm_pkg_t *p) { (void)p; return 0; }
int alpm_pkg_compute_optionalfor(alpm_pkg_t *p) { (void)p; return 0; }
int alpm_pkg_set_reason(alpm_handle_t *h, alpm_pkg_t *p, int r) { (void)h; (void)p; (void)r; return 0; }
void *alpm_sync_get_new_version(alpm_pkg_t *p, void *dbs) { (void)p; (void)dbs; return NULL; }
int alpm_compute_md5sum(const char *f, char **s) { (void)f; (void)s; return -1; }
int alpm_compute_sha256sum(const char *f, unsigned char **s) { (void)f; (void)s; return -1; }

/* Transaction operations */
int alpm_trans_interrupt(alpm_handle_t *h) { (void)h; return 0; }
int alpm_trans_get_flags(alpm_handle_t *h) { (void)h; return 0; }
void *alpm_trans_get_add(alpm_handle_t *h) { (void)h; return NULL; }
void *alpm_trans_get_remove(alpm_handle_t *h) { (void)h; return NULL; }
int alpm_unregister_all_syncdbs(alpm_handle_t *h) { (void)h; return 0; }
int alpm_sandbox_setup_child(alpm_handle_t *h, const char *u, const char *p, int r) { (void)h; (void)u; (void)p; (void)r; return 0; }
