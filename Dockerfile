FROM ubuntu:22.04 as base
RUN apt-get update && apt-get -y install bash curl git wget libatomic1 python3 build-essential
COPY .nvmrc /usr/src/app/
RUN rm /bin/sh && ln -s /bin/bash /bin/sh
ENV NVM_DIR /usr/local/nvm
RUN mkdir $NVM_DIR
ENV NODE_VERSION=v20.16.0
# Install nvm with node and npm
RUN curl https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.5/install.sh | bash \
    && source $NVM_DIR/nvm.sh \
    && nvm install $NODE_VERSION \
    && nvm alias default $NODE_VERSION \
    && nvm use default
ENV NODE_PATH $NVM_DIR/$NODE_VERSION/lib/node_modules
ENV PATH $NVM_DIR/versions/node/$NODE_VERSION/bin:$PATH

FROM base as builder
COPY package*.json /usr/src/app/
WORKDIR /usr/src/app/
RUN npm ci


FROM base as runner
COPY . /usr/src/app
WORKDIR /usr/src/app/
COPY --from=builder /usr/src/app/node_modules/ /usr/src/app/node_modules/
RUN npm run build
ENV NODE_ENV='production'
CMD ["npm","run","start"]