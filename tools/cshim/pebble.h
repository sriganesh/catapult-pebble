/*
 * Just enough of pebble.h to compile store.c on the host.
 *
 * persist_* is backed by a fixed 256-byte slot, the same limit the watch has,
 * so an oversized write fails here exactly as it does on the device.
 */
#pragma once

#include <stdbool.h>
#include <stdint.h>
#include <stddef.h>
#include <stdio.h>
#include <string.h>

#define APP_LOG_LEVEL_ERROR 1
#define APP_LOG_LEVEL_INFO 2
#define APP_LOG(...) ((void)0)

// A stand-in for the watch's persistent store: a handful of slots, each a
// blob, which is all store.c ever asks of it.
#define SHIM_MAX_SLOTS 32
// The real SDK's limit; a bigger one would hide the chunking bug.
#define PERSIST_DATA_MAX_LENGTH 256
#define SHIM_MAX_BYTES PERSIST_DATA_MAX_LENGTH

typedef struct {
  bool present;
  uint8_t bytes[SHIM_MAX_BYTES];
  size_t size;
} ShimSlot;

extern ShimSlot shim_slots[SHIM_MAX_SLOTS];

void shim_reset(void);

bool persist_exists(const uint32_t key);
int persist_read_data(const uint32_t key, void *buffer, const size_t size);
int persist_write_data(const uint32_t key, const void *data, const size_t size);
int persist_read_string(const uint32_t key, char *buffer, const size_t size);
int persist_write_string(const uint32_t key, const char *value);
bool persist_read_bool(const uint32_t key);
int persist_write_bool(const uint32_t key, const bool value);
int persist_read_int(const uint32_t key);
int persist_write_int(const uint32_t key, const int value);
void persist_delete(const uint32_t key);
typedef int status_t;
