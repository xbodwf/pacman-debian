#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#include <fcntl.h>
#include <errno.h>
#include <string.h>
#include <signal.h>

static int lock_fd = -1;
static int frontend_fd = -1;

static void cleanup(int sig) {
  (void)sig;
  if (lock_fd >= 0)     { close(lock_fd); lock_fd = -1; }
  if (frontend_fd >= 0) { close(frontend_fd); frontend_fd = -1; }
  _exit(0);
}

static int acquire_lock(const char *path, int timeout) {
  int fd = open(path, O_RDWR | O_CREAT, 0644);
  if (fd < 0) return -1;

  struct flock fl;
  fl.l_type = F_WRLCK;
  fl.l_whence = SEEK_SET;
  fl.l_start = 0;
  fl.l_len = 0;

  for (int i = 0;; i++) {
    if (fcntl(fd, F_SETLK, &fl) == 0) return fd;
    if (errno != EAGAIN && errno != EACCES) { close(fd); return -1; }
    if (i >= timeout) {
      close(fd);
      errno = EBUSY;
      return -2;
    }
    sleep(1);
  }
}

int main(int argc, char *argv[]) {
  int timeout = 30;
  if (argc > 1) { timeout = atoi(argv[1]); if (timeout < 0) timeout = 0; }

  signal(SIGTERM, cleanup);
  signal(SIGINT, cleanup);

  frontend_fd = acquire_lock("/var/lib/dpkg/lock-frontend", timeout);
  if (frontend_fd < 0) {
    if (frontend_fd == -2) fprintf(stderr, "dpkg frontend lock is held by another process\n");
    else fprintf(stderr, "Cannot open dpkg frontend lock: %s\n", strerror(errno));
    return frontend_fd == -2 ? 3 : 1;
  }

  lock_fd = acquire_lock("/var/lib/dpkg/lock", timeout);
  if (lock_fd < 0) {
    if (lock_fd == -2) fprintf(stderr, "dpkg lock is held by another process\n");
    else fprintf(stderr, "Cannot open dpkg lock: %s\n", strerror(errno));
    close(frontend_fd);
    return 2;
  }

  write(1, "ok\n", 3);

  char buf[4096];
  while (read(0, buf, sizeof(buf)) > 0) {}

  cleanup(0);
  return 0;
}
