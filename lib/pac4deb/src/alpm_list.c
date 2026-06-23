/*
 * alpm_list.c - simplified from pacman source (GPL-2.0-or-later)
 * Copyright (C) 2006-2025 Pacman Development Team
 */
#include <stdlib.h>
#include <string.h>
#include "alpm_list.h"

alpm_list_t *alpm_list_add(alpm_list_t *list, void *data) {
	alpm_list_t *ptr, *lp = malloc(sizeof(alpm_list_t));
	if (!lp) return list;
	lp->data = data;
	lp->prev = NULL;
	lp->next = NULL;
	if (!list) return lp;
	ptr = list;
	while (ptr->next) ptr = ptr->next;
	ptr->next = lp;
	lp->prev = ptr;
	return list;
}

/* Fast append: returns the new tail for subsequent calls */
alpm_list_t *alpm_list_add_last(alpm_list_t *list, alpm_list_t *tail, void *data) {
	alpm_list_t *lp = malloc(sizeof(alpm_list_t));
	if (!lp) return NULL;
	lp->data = data;
	lp->prev = NULL;
	lp->next = NULL;
	if (!list) { list = lp; tail = lp; return tail ? tail : list; }
	// If we have a valid tail, use it directly
	if (tail) {
		tail->next = lp;
		lp->prev = tail;
		return lp;
	}
	// Fallback: find tail
	alpm_list_t *ptr = list;
	while (ptr->next) ptr = ptr->next;
	ptr->next = lp;
	lp->prev = ptr;
	return lp;
}

void alpm_list_free(alpm_list_t *list) {
	alpm_list_t *it = list;
	while (it) { alpm_list_t *next = it->next; free(it); it = next; }
}

void alpm_list_free_inner(alpm_list_t *list, void (*fn)(void*)) {
	alpm_list_t *it = list;
	while (it) { if (fn && it->data) fn(it->data); it = it->next; }
}

int alpm_list_count(const alpm_list_t *list) {
	int i = 0;
	while (list) { i++; list = list->next; }
	return i;
}

alpm_list_t *alpm_list_nth(const alpm_list_t *list, int n) {
	while (list && n--) list = list->next;
	return (alpm_list_t *)list;
}

alpm_list_t *alpm_list_next(const alpm_list_t *list) {
	return list ? list->next : NULL;
}

alpm_list_t *alpm_list_previous(const alpm_list_t *list) {
	return list ? list->prev : NULL;
}

alpm_list_t *alpm_list_last(const alpm_list_t *list) {
	if (!list) return NULL;
	while (list->next) list = list->next;
	return (alpm_list_t *)list;
}

alpm_list_t *alpm_list_reverse(alpm_list_t *list) {
	alpm_list_t *new = NULL, *it = list;
	while (it) { alpm_list_t *next = it->next; it->next = new; it->prev = next; new = it; it = next; }
	return new;
}

alpm_list_t *alpm_list_join(alpm_list_t *first, alpm_list_t *second) {
	if (!first) return second;
	alpm_list_t *last = alpm_list_last(first);
	last->next = second;
	if (second) second->prev = last;
	return first;
}

alpm_list_t *alpm_list_copy(const alpm_list_t *list) {
	alpm_list_t *new = NULL;
	while (list) { new = alpm_list_add(new, list->data); list = list->next; }
	return new;
}

void *alpm_list_find(const alpm_list_t *haystack, const void *needle,
		int (*fn)(const void *, const void *)) {
	while (haystack) {
		if (fn(needle, haystack->data) == 0) return haystack->data;
		haystack = haystack->next;
	}
	return NULL;
}

void *alpm_list_find_str(const alpm_list_t *haystack, const char *needle) {
	while (haystack) {
		if (haystack->data && strcmp((const char *)haystack->data, needle) == 0)
			return haystack->data;
		haystack = haystack->next;
	}
	return NULL;
}

alpm_list_t *alpm_list_remove(alpm_list_t *list, const void *needle,
		int (*fn)(const void *, const void *), void **data) {
	alpm_list_t *it = list;
	while (it) {
		if (fn(needle, it->data) == 0) {
			if (data) *data = it->data;
			if (it->prev) it->prev->next = it->next;
			if (it->next) it->next->prev = it->prev;
			if (it == list) list = it->next;
			free(it);
			return list;
		}
		it = it->next;
	}
	return list;
}

alpm_list_t *alpm_list_remove_item(alpm_list_t *list, alpm_list_t *item) {
	if (item->prev) item->prev->next = item->next;
	if (item->next) item->next->prev = item->prev;
	if (list == item) list = item->next;
	item->prev = NULL;
	item->next = NULL;
	return list;
}
