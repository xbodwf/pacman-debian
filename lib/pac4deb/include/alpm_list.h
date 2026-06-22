#ifndef ALPM_LIST_H
#define ALPM_LIST_H

#include <stdlib.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct __alpm_list_t {
	void *data;
	struct __alpm_list_t *prev;
	struct __alpm_list_t *next;
} alpm_list_t;

typedef int (*alpm_list_fn_cmp)(const void *, const void *);
typedef void (*alpm_list_fn_free)(void *);

alpm_list_t *alpm_list_add(alpm_list_t *list, void *data);
alpm_list_t *alpm_list_add_sorted(alpm_list_t *list, void *data, alpm_list_fn_cmp fn);
void alpm_list_free(alpm_list_t *list);
void alpm_list_free_inner(alpm_list_t *list, alpm_list_fn_free fn);
alpm_list_t *alpm_list_remove(alpm_list_t *list, const void *needle, alpm_list_fn_cmp fn, void **data);
alpm_list_t *alpm_list_remove_item(alpm_list_t *list, alpm_list_t *item);
alpm_list_t *alpm_list_remove_str(alpm_list_t *list, const char *needle, char **data);
alpm_list_t *alpm_list_strdup(alpm_list_t *list);
int alpm_list_count(const alpm_list_t *list);
alpm_list_t *alpm_list_nth(const alpm_list_t *list, int n);
alpm_list_t *alpm_list_next(const alpm_list_t *list);
alpm_list_t *alpm_list_previous(const alpm_list_t *list);
alpm_list_t *alpm_list_last(const alpm_list_t *list);
alpm_list_t *alpm_list_reverse(alpm_list_t *list);
alpm_list_t *alpm_list_join(alpm_list_t *first, alpm_list_t *second);
alpm_list_t *alpm_list_copy(const alpm_list_t *list);
alpm_list_t *alpm_list_copy_data(const alpm_list_t *list, size_t size);
void *alpm_list_find(const alpm_list_t *haystack, const void *needle, alpm_list_fn_cmp fn);
alpm_list_t *alpm_list_diff(const alpm_list_t *lhs, const alpm_list_t *rhs, alpm_list_fn_cmp fn);

#ifdef __cplusplus
}
#endif

#endif
