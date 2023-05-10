FROM --platform=linux/amd64 almalinux:8.6

# jdk-corretto 11
ARG version=11.0.17.8-1

RUN set -eux \
    && export GNUPGHOME="$(mktemp -d)" \
    && curl -fL -o corretto.key https://yum.corretto.aws/corretto.key \
    && gpg --batch --import corretto.key \
    && gpg --batch --export --armor '6DC3636DAE534049C8B94623A122542AB04F24E3' > corretto.key \
    && rpm --import corretto.key \
    && rm -r "$GNUPGHOME" corretto.key \
    && curl -fL -o /etc/yum.repos.d/corretto.repo https://yum.corretto.aws/corretto.repo \
    && grep -q '^gpgcheck=1' /etc/yum.repos.d/corretto.repo \
    && echo "priority=9" >> /etc/yum.repos.d/corretto.repo \
    && yum install -y java-11-amazon-corretto-devel-$version \
    && (find /usr/lib/jvm/java-11-amazon-corretto -name src.zip -delete || true) \
    && yum install -y fontconfig \
    && yum clean all

ENV LANG C.UTF-8
ENV JAVA_HOME=/usr/lib/jvm/java-11-amazon-corretto


# gradle 7.6
# CMD ["gradle"]

ENV GRADLE_HOME=/opt/gradle

RUN set -o errexit -o nounset \
    && echo "Adding gradle user and group" \
    && groupadd --system --gid 1000 gradle \
    && useradd --system --gid gradle --uid 1000 --shell /bin/bash --create-home gradle \
    && mkdir /home/gradle/.gradle \
    && chown --recursive gradle:gradle /home/gradle \
    \
    && echo "Symlinking root Gradle cache to gradle Gradle cache" \
    && ln --symbolic /home/gradle/.gradle /root/.gradle

VOLUME /home/gradle/.gradle

WORKDIR /home/gradle

RUN set -o errexit -o nounset \
    && yum update -y \
    && yum install -y \
        wget \
        vim \
        unzip \
#        \
#        bzr \
        git \
        git-lfs
#        mercurial \
#        openssh-client \
#        subversion \
#    \
#    && echo "Testing VCSes" \
#    && which bzr \
#    && which git \
#    && which git-lfs \
#    && which hg \
#    && which svn


# 如使用挂载宿主机Docker方案,则无需安装docker
#RUN set -o errexit -o nounset \
#    && echo "install docker" \
#    && dnf install -y yum-utils \
#    && dnf config-manager --add-repo=https://download.docker.com/linux/centos/docker-ce.repo \
#    && dnf -y install docker-ce docker-ce-cli containerd.io


ENV GRADLE_VERSION=7.6

# ARG GRADLE_DOWNLOAD_SHA256=f6b8596b10cce501591e92f229816aa4046424f3b24d771751b06779d58c8ec4

RUN set -o errexit -o nounset \
    && echo "Downloading Gradle" \
    && wget --no-verbose --output-document=gradle.zip "https://services.gradle.org/distributions/gradle-${GRADLE_VERSION}-bin.zip" \
    \
    && echo "Checking download hash" \
#     && echo "${GRADLE_DOWNLOAD_SHA256} *gradle.zip" | sha256sum --check - \
    \
    && echo "Installing Gradle" \
    && unzip gradle.zip \
    && rm gradle.zip \
    && mv "gradle-${GRADLE_VERSION}" "${GRADLE_HOME}/" \
    && ln --symbolic "${GRADLE_HOME}/bin/gradle" /usr/bin/gradle \
    \
    && echo "Testing Gradle installation" \
    && gradle --version

ENV MAVEN_HOME /usr/share/maven

COPY --from=maven:3.9.1-eclipse-temurin-11 ${MAVEN_HOME} ${MAVEN_HOME}
COPY --from=maven:3.9.1-eclipse-temurin-11 /usr/local/bin/mvn-entrypoint.sh /usr/local/bin/mvn-entrypoint.sh
COPY --from=maven:3.9.1-eclipse-temurin-11 /usr/share/maven/ref/settings-docker.xml /usr/share/maven/ref/settings-docker.xml

RUN ln -s ${MAVEN_HOME}/bin/mvn /usr/bin/mvn

ARG MAVEN_VERSION=3.9.1
ARG USER_HOME_DIR="/root"
ENV MAVEN_CONFIG "$USER_HOME_DIR/.m2"


# nodejs 18.14.2 npm 9.5.0
WORKDIR /root

ENV NODEJS_HOME=/opt/nodejs

ENV NODEJS_VERSION=v18.14.2

RUN set -o errexit -o nounset \
    && echo "Downloading NodeJS" \
    && wget --no-verbose --output-document=nodejs.tar.xz "https://nodejs.org/dist/${NODEJS_VERSION}/node-${NODEJS_VERSION}-linux-x64.tar.xz" \
    \
    && echo "Install NodeJS" \
    && tar xf nodejs.tar.xz \
    && rm nodejs.tar.xz \
    && mv "node-${NODEJS_VERSION}-linux-x64" "${NODEJS_HOME}/" \
    && ln --symbolic "${NODEJS_HOME}/bin/node" /usr/bin/node \
    && ln --symbolic "${NODEJS_HOME}/bin/npm" /usr/bin/npm \
    && npm install --location=global npm@9.5.0 \
    \
    && echo "Testing NodeJS installation" \
    && node -v && npm -v
ENV PATH=$PATH:${NODEJS_HOME}/bin

# bit 0.0.1000
# USER root
# ENV BVM_VERSION=0.3.1
# ENV BIT_VERSION=0.0.1000
# ENV PATH=$PATH:/root/bin
# ENV NODE_OPTIONS=--max_old_space_size=4096

# RUN set -o errexit -o nounset \
#     && echo "Install bvm" \
#     && npm install --location=global @teambit/bvm@${BVM_VERSION} \
#     \
#     && echo "Install bit" \
#     && bvm install ${BIT_VERSION} \
#     \
#     && echo "Testing installation" \
#     && bvm version && bit -v

# RUN set -o errexit -o nounset \
#     && echo "Configure bit" \
#     && bit config set analytics_reporting false \
#     && bit config set no_warnings false \
#     && bit config set interactive false \
#     && bit config set error_reporting true


# skaffold 2
RUN set -o errexit -o nounset \
    && echo "Downloading Skaffold" \
    && wget --no-verbose --output-document=skaffold "https://storage.googleapis.com/skaffold/releases/latest/skaffold-linux-amd64" \
    \
    && echo "Install Skaffold" \
    && install skaffold /usr/bin/ \
    \
    && echo "Testing Skaffold installation" \
    && skaffold version

# kustomize
ENV KUSTOMIZE_VERSION=v4.5.7
RUN set -o errexit -o nounset \
    && echo "Downloading kustomize" \
    && wget --no-verbose --output-document=kustomize.tar.gz "https://github.com/kubernetes-sigs/kustomize/releases/download/kustomize%2F${KUSTOMIZE_VERSION}/kustomize_${KUSTOMIZE_VERSION}_linux_amd64.tar.gz" \
    && tar -zxvf kustomize.tar.gz \
    && echo "Install kustomize" \
    && install kustomize /usr/bin/ \

