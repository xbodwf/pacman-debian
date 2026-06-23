#ifndef ALPM_H
#define ALPM_H

#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>
#include <stdarg.h>
#include <sys/types.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Opaque types */
typedef struct __alpm_handle_t alpm_handle_t;
typedef struct __alpm_db_t alpm_db_t;
typedef struct __alpm_pkg_t alpm_pkg_t;
typedef struct __alpm_list_t alpm_list_t;

/* Time type */
typedef int64_t alpm_time_t;

/* Package reason */
typedef enum _alpm_pkgreason_t {
	ALPM_PKG_REASON_EXPLICIT = 0,
	ALPM_PKG_REASON_DEPEND = 1,
} alpm_pkgreason_t;

/* Package origin */
typedef enum _alpm_pkgfrom_t {
	ALPM_PKG_FROM_FILE = 1,
	ALPM_PKG_FROM_LOCALDB,
	ALPM_PKG_FROM_SYNCDB,
} alpm_pkgfrom_t;

/* Package validation */
typedef enum _alpm_pkgvalidation_t {
	ALPM_PKG_VALIDATION_UNKNOWN = 0,
	ALPM_PKG_VALIDATION_NONE,
	ALPM_PKG_VALIDATION_SIGNATURE,
	ALPM_PKG_VALIDATION_CHECKSUM,
} alpm_pkgvalidation_t;

/* Error codes */
typedef enum _alpm_errno_t {
	ALPM_ERR_OK = 0,
	ALPM_ERR_MEMORY = 1,
	ALPM_ERR_SYSTEM = 2,
	ALPM_ERR_BADPERMS = 3,
	ALPM_ERR_NOT_A_FILE = 4,
	ALPM_ERR_NOT_A_DIR = 5,
	ALPM_ERR_WRONG_ARGS = 6,
	ALPM_ERR_DB_NOT_NULL = 7,
	ALPM_ERR_DB_NOT_FOUND = 8,
	ALPM_ERR_PKG_NOT_FOUND = 9,
	ALPM_ERR_LIBARCHIVE = 10,
	ALPM_ERR_LIBCURL = 11,
	ALPM_ERR_HANDLE_NULL = 12,
	ALPM_ERR_HANDLE_NOT_NULL = 13,
	ALPM_ERR_DB_VERSION = 14,
	ALPM_ERR_DB_WRITE = 15,
	ALPM_ERR_DB_REMOVE = 16,
	ALPM_ERR_SERVER_BAD_URL = 17,
	ALPM_ERR_TRANS_NOT_NULL = 18,
	ALPM_ERR_TRANS_NULL = 19,
	ALPM_ERR_PKG_INVALID = 20,
} alpm_errno_t;

/* Capabilities */
typedef enum _alpm_caps_t {
	ALPM_CAPABILITY_NLS = 1,
} alpm_caps_t;

/* Log levels */
typedef enum _alpm_loglevel_t {
	ALPM_LOG_DEBUG = 1,
	ALPM_LOG_ERROR = 2,
	ALPM_LOG_WARNING = 4,
	ALPM_LOG_FUNCTION = 8,
} alpm_loglevel_t;

typedef void (*alpm_cb_log)(alpm_loglevel_t, const char *, va_list);

/* ---- Handle ---- */
alpm_handle_t *alpm_initialize(const char *root, const char *dbpath, alpm_errno_t *err);
int alpm_release(alpm_handle_t *handle);

/* ---- Errors ---- */
alpm_errno_t alpm_errno(alpm_handle_t *handle);
const char *alpm_strerror(alpm_errno_t err);

/* ---- Databases ---- */
alpm_db_t *alpm_db_register_local(alpm_handle_t *handle);
alpm_db_t *alpm_db_register_sync(alpm_handle_t *handle, const char *treename);
int alpm_db_unregister_all(alpm_handle_t *handle);
alpm_pkg_t *alpm_db_get_pkg(alpm_db_t *db, const char *name);
alpm_list_t *alpm_db_get_pkgcache(alpm_db_t *db);
int alpm_db_set_pkgreason(alpm_handle_t *handle, const char *name, alpm_pkgreason_t reason);

/* ---- Packages ---- */
const char *alpm_pkg_get_name(alpm_pkg_t *pkg);
const char *alpm_pkg_get_version(alpm_pkg_t *pkg);
const char *alpm_pkg_get_desc(alpm_pkg_t *pkg);
const char *alpm_pkg_get_url(alpm_pkg_t *pkg);
const char *alpm_pkg_get_arch(alpm_pkg_t *pkg);
const char *alpm_pkg_get_base64_sig(alpm_pkg_t *pkg);
int alpm_pkg_get_sig(alpm_pkg_t *pkg, void **sig, size_t *sig_len);
alpm_pkgreason_t alpm_pkg_get_reason(alpm_pkg_t *pkg);
alpm_pkgfrom_t alpm_pkg_get_origin(alpm_pkg_t *pkg);
alpm_time_t alpm_pkg_get_builddate(alpm_pkg_t *pkg);
alpm_time_t alpm_pkg_get_installdate(alpm_pkg_t *pkg);
off_t alpm_pkg_get_size(alpm_pkg_t *pkg);
off_t alpm_pkg_get_isize(alpm_pkg_t *pkg);
alpm_pkgvalidation_t alpm_pkg_get_validation(alpm_pkg_t *pkg);
int alpm_pkg_has_scriptlet(alpm_pkg_t *pkg);
void alpm_pkg_free(alpm_pkg_t *pkg);

/* ---- Options ---- */
int alpm_option_add_cachedir(alpm_handle_t *handle, const char *cachedir);
int alpm_option_set_cachedirs(alpm_handle_t *handle, alpm_list_t *cachedirs);
int alpm_option_set_usesyslog(alpm_handle_t *handle, int use);
int alpm_option_set_dbpath(alpm_handle_t *handle, const char *dbpath);
int alpm_option_set_logfile(alpm_handle_t *handle, const char *logfile);
const char *alpm_option_get_dbpath(alpm_handle_t *handle);
const char *alpm_option_get_config_path(alpm_handle_t *handle);
const char *alpm_option_get_conf_path(alpm_handle_t *handle);
int alpm_option_set_config_path(alpm_handle_t *handle, const char *path);
int alpm_option_set_conf_path(alpm_handle_t *handle, const char *path);
alpm_db_t *alpm_option_get_localdb(alpm_handle_t *handle);
alpm_list_t *alpm_option_get_syncdbs(alpm_handle_t *handle);

/* ---- Logging ---- */
int alpm_logaction(alpm_handle_t *handle, const char *fmt, ...);

/* ---- Version comparison ---- */
int alpm_pkg_vercmp(const char *a, const char *b);

/* ---- Misc ---- */
const char *alpm_version(void);
int alpm_capabilities(void);

/* Go/CGO binding aliases used by AUR helpers */
alpm_db_t *alpm_get_localdb(alpm_handle_t *handle);
alpm_list_t *alpm_get_syncdbs(alpm_handle_t *handle);
int alpm_db_unregister(alpm_db_t *db);
int alpm_option_set_gpgdir(alpm_handle_t *handle, const char *gpgdir);
const char *alpm_option_get_gpgdir(alpm_handle_t *handle);
const char *alpm_option_get_logfile(alpm_handle_t *handle);
int alpm_option_set_local_file_siglevel(alpm_handle_t *handle, int level);
int alpm_option_get_local_file_siglevel(alpm_handle_t *handle);
int alpm_option_set_remote_file_siglevel(alpm_handle_t *handle, int level);
int alpm_option_get_remote_file_siglevel(alpm_handle_t *handle);
int alpm_option_set_dbext(alpm_handle_t *handle, const char *ext);
const char *alpm_option_get_dbext(alpm_handle_t *handle);
int alpm_option_set_disable_dl_timeout(alpm_handle_t *handle, int disable);
int alpm_option_get_disable_dl_timeout(alpm_handle_t *handle);
int alpm_option_set_disable_sandbox(alpm_handle_t *handle, int disable);
int alpm_option_get_disable_sandbox(alpm_handle_t *handle);
int alpm_trans_init(alpm_handle_t *handle, int flags);
int alpm_trans_prepare(alpm_handle_t *handle);
int alpm_trans_commit(alpm_handle_t *handle);
int alpm_trans_release(alpm_handle_t *handle);
int alpm_add_pkg(alpm_handle_t *handle, alpm_pkg_t *pkg);
int alpm_remove_pkg(alpm_handle_t *handle, alpm_pkg_t *pkg);
int alpm_sync_sysupgrade(alpm_handle_t *handle, int enable_downgrade);

#ifdef __cplusplus
}
#endif

#endif /* ALPM_H */
