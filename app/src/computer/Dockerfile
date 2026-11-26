FROM docker.io/trycua/xfce-cua@sha256:274eb636f5cf3fc58f705916ee72b7a701270b3877369d08533a385c5325be9b

RUN set -eu; \
    sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources; \
    apt-get -o Acquire::Retries=2 -o Acquire::https::Timeout=30 update; \
    apt-get -o Acquire::Retries=2 -o Acquire::https::Timeout=30 install -y --no-install-recommends chromium; \
    apt-get clean; \
    rm -rf /var/lib/apt/lists/*

COPY cua_driver-0.37.0-py3-none-manylinux_2_31_x86_64.whl /tmp/
RUN set -eu; \
    wheel=/tmp/cua_driver-0.37.0-py3-none-manylinux_2_31_x86_64.whl; \
    echo "e530ee36226d99516ef7ec696ba31d516e487ae5e5effdd5e2610c56af3eee19  $wheel" | sha256sum -c -; \
    /opt/venv/bin/python -m pip install --no-cache-dir --force-reinstall --no-deps "$wheel"; \
    rm "$wheel"; \
    test "$(/opt/venv/bin/cua-driver --version)" = 'cua-driver 0.37.0'; \
    install -d -o root -g root -m 1777 /tmp/.X11-unix; \
    install -d -o cua -g cua -m 0700 /home/cua/workspace /home/cua/.config/chromium; \
    touch /home/cua/workspace/.ds-bot-workspace /home/cua/.config/chromium/.ds-bot-profile; \
    chown cua:cua /home/cua/workspace/.ds-bot-workspace /home/cua/.config/chromium/.ds-bot-profile
RUN set -eu; \
    apt-get -o Acquire::Retries=2 -o Acquire::https::Timeout=30 update; \
    apt-get -o Acquire::Retries=2 -o Acquire::https::Timeout=30 install -y --no-install-recommends fonts-noto-cjk; \
    fc-cache -f; \
    apt-get clean; \
    rm -rf /var/lib/apt/lists/*
COPY --chmod=755 start-desktop.sh /usr/local/bin/ds-bot-desktop
USER 1000:1000
HEALTHCHECK NONE
ENTRYPOINT ["/usr/local/bin/ds-bot-desktop"]
CMD []
LABEL io.github.qingj01.dsbot.cua-image="6"
